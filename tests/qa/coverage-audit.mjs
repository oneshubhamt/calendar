import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scenarioTags } from "../browser/scenario-registry.mjs";
import { requiredInvariants, requiredRiskClasses } from "./witness-registry.mjs";

const nodeFiles = globSync("tests/node/**/*.test.mjs").sort();
const browserFiles = globSync("tests/browser/**/*.spec.mjs").sort();

function nodeWitnesses() {
  const witnesses = new Map();
  for (const file of nodeFiles) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/^(test|deepTest)\(\s*["']([^"']+)["']/gm)) {
      const key = `${file}::${match[2]}`;
      assert.equal(witnesses.has(key), false, `Duplicate Node witness: ${key}`);
      witnesses.set(key, { deep: match[1] === "deepTest" });
    }
  }
  return witnesses;
}

function browserDeclarations() {
  const byId = new Map();
  const byTitle = new Map();
  for (const file of browserFiles) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/^scenario\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/gm)) {
      const [, id, title] = match;
      assert.equal(byId.has(id), false, `Duplicate browser scenario declaration: ${id}`);
      assert.equal(byTitle.has(title), false, `Duplicate browser scenario title: ${title}`);
      byId.set(id, { file, title });
      byTitle.set(title, id);
    }
  }
  assert.deepEqual([...byId.keys()].sort(), Object.keys(scenarioTags).sort(),
    "Browser scenario registry and executable declarations differ");
  return { byId, byTitle };
}

function expectedScenarioIds(lane) {
  const entries = Object.entries(scenarioTags);
  if (lane === "release") return new Set(entries.map(([id]) => id));
  if (lane === "smoke") return new Set(entries.filter(([, tags]) => tags.includes("smoke") || tags.includes("cross")).map(([id]) => id));
  if (lane === "cross") return new Set(entries.filter(([, tags]) => tags.includes("cross")).map(([id]) => id));
  if (lane === "visual") return new Set(entries.filter(([, tags]) => tags.includes("visual")).map(([id]) => id));
  throw new Error(`Unknown browser lane: ${lane}`);
}

function discoverBrowserLane(lane, byTitle) {
  const cli = fileURLToPath(new URL("../../node_modules/@playwright/test/cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "test", "--config=playwright.config.mjs", "--list"], {
    encoding: "utf8",
    env: { ...process.env, CALENDAR_QA_LANE: lane },
    maxBuffer: 5 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${lane} discovery failed: ${result.stderr || result.stdout}`);

  const ids = new Set();
  for (const line of result.stdout.split("\n")) {
    if (!line.includes(" › ")) continue;
    const tail = line.split(" › ").at(-1)?.replace(/\s+@release(?:\s+@\w+)*\s*$/, "");
    if (!tail) continue;
    const id = byTitle.get(tail);
    if (id) ids.add(id);
  }
  return ids;
}

function assertSameSet(actual, expected, label) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), label);
}

const node = nodeWitnesses();
const browser = browserDeclarations();

for (const lane of ["release", "smoke", "cross", "visual"]) {
  assertSameSet(
    discoverBrowserLane(lane, browser.byTitle),
    expectedScenarioIds(lane),
    `${lane} browser lane membership differs from scenario tags`,
  );
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const executableWitnesses = new Map();
for (const invariant of requiredInvariants) {
  assert.ok(invariant.witnesses.length > 0, `${invariant.id} has no witness`);
  let executable = 0;
  for (const witness of invariant.witnesses) {
    if (witness.kind === "node") {
      const key = `${witness.file}::${witness.title}`;
      assert.ok(node.has(key), `${invariant.id} missing Node witness: ${key}`);
      executableWitnesses.set(`node:${key}`, { risk: invariant.risk, deep: node.get(key).deep });
      executable += 1;
    } else if (witness.kind === "browser") {
      assert.ok(browser.byId.has(witness.id), `${invariant.id} missing browser witness: ${witness.id}`);
      executableWitnesses.set(`browser:${witness.id}`, { risk: invariant.risk });
      executable += 1;
    } else if (witness.kind === "script") {
      assert.ok(existsSync(witness.file), `${invariant.id} missing script witness: ${witness.file}`);
      assert.ok(Object.values(pkg.scripts ?? {}).some(value => value.includes(witness.scriptToken)),
        `${invariant.id} script witness is not wired into package scripts: ${witness.scriptToken}`);
      executableWitnesses.set(`script:${witness.file}:${witness.scriptToken}`, { risk: invariant.risk });
      executable += 1;
    } else {
      assert.fail(`${invariant.id} has unknown witness kind: ${witness.kind}`);
    }
  }
  assert.ok(executable > 0, `${invariant.id} has no executable witness`);
}

function risksForLane(lane) {
  const risks = new Set();
  const browserIds = lane === "routine" ? expectedScenarioIds("smoke") : expectedScenarioIds("release");
  for (const [key, witness] of executableWitnesses) {
    if (key.startsWith("node:")) {
      if (lane === "release" || !witness.deep) risks.add(witness.risk);
    } else if (key.startsWith("browser:")) {
      const id = key.slice("browser:".length);
      if (browserIds.has(id)) risks.add(witness.risk);
    } else if (key.startsWith("script:")) {
      risks.add(witness.risk);
    }
  }
  return risks;
}

for (const lane of ["routine", "release"]) {
  const risks = risksForLane(lane);
  for (const risk of requiredRiskClasses[lane]) {
    assert.ok(risks.has(risk), `${lane} QA has no executable witness for required risk class: ${risk}`);
  }
}

console.log(
  `QA contract registry verified: ${requiredInvariants.length} required invariants; `
  + `routine risks [${[...risksForLane("routine")].sort().join(", ")}]; `
  + `release risks [${[...risksForLane("release")].sort().join(", ")}]`,
);
