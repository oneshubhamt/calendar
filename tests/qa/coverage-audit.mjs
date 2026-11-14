import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scenarioTags } from "../browser/scenario-registry.mjs";

// Contract inventory, not an architecture source-shape heuristic.
// Runtime discovery below independently verifies how Playwright selects each engine.
const nodeFiles = globSync("tests/node/**/*.test.mjs").sort();
const browserFiles = globSync("tests/browser/**/*.spec.mjs").sort();
assert.equal(nodeFiles.length, 25, "Node domain module census changed");
assert.equal(browserFiles.length, 13, "Browser domain module census changed");

const nodeCases = nodeFiles.reduce((total, path) =>
  total + [...readFileSync(path, "utf8").matchAll(/^(?:test|deepTest)\(/gm)].length, 0);
assert.equal(nodeCases, 211, "Node case contract changed; update the coverage map deliberately");
const deepCases = nodeFiles.reduce((total, path) =>
  total + [...readFileSync(path, "utf8").matchAll(/^deepTest\(/gm)].length, 0);
assert.equal(deepCases, 4, "Deep/stress Node witness count changed; reconcile fast/full selection deliberately");

const ids = browserFiles.flatMap(path =>
  [...readFileSync(path, "utf8").matchAll(/^scenario\("([^"]+)"/gm)].map(match => match[1]));
assert.equal(ids.length, 55);
assert.equal(new Set(ids).size, 55, "Duplicate browser scenario declarations");
assert.deepEqual([...ids].sort(), Object.keys(scenarioTags).sort(), "Browser registry is not exhaustive");

const screenshots = globSync("tests/browser/__screenshots__/*.png");
assert.equal(screenshots.length, 9, "Visual baseline count changed");
const visualText = readFileSync("tests/browser/visual.spec.mjs", "utf8");
for (const path of screenshots) {
  assert.ok(visualText.includes(`"${path.split("/").at(-1)}"`),
    `Unreferenced visual baseline: ${path}`);
}

const cli = fileURLToPath(new URL("../../node_modules/@playwright/test/cli.js", import.meta.url));
for (const [lane, expected] of [["release", 147], ["smoke", 53], ["cross", 42], ["visual", 9]]) {
  const result = spawnSync(process.execPath, [cli, "test", "--config=playwright.config.mjs", "--list"], {
    encoding: "utf8", env: { ...process.env, CALENDAR_QA_LANE: lane },
    maxBuffer: 5 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${lane} discovery failed: ${result.stderr || result.stdout}`);
  const actual = Number(/Total:\s*(\d+)\s+tests?\s+in\s+\d+\s+files?/.exec(result.stdout)?.[1]);
  assert.equal(actual, expected, `${lane} test discovery differs from the accepted release baseline`);
  console.log(`${lane}: ${actual} discovered executions`);
}
console.log(`Coverage census: ${nodeCases} Node cases (${deepCases} deep/full-only), ${ids.length} unique browser scenarios, ${screenshots.length} visual baselines`);
