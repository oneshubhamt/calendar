import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Deliberately small, named faults tied to independently modelled invariants.
// These modify compiled artifacts only, in isolation, and always restore the original bytes.
const mutations = [
  {
    name: "half-open interval boundary becomes closed",
    file: "dist/core/interaction.js",
    from: "return aStartMs < bEndMs && aEndMs > bStartMs;",
    to: "return aStartMs <= bEndMs && aEndMs > bStartMs;",
    test: "tests/node/temporal/mathematical-invariants.test.mjs",
    title: "interval collision semantics match the half-open interval model exhaustively on a finite lattice",
  },
  {
    name: "stale revision guard allows overwrites",
    file: "dist/core/store.js",
    from: "if (this.snapshotValue.revision !== expectedRevision) {",
    to: "if (false) {",
    test: "tests/node/engine/core.test.mjs",
    title: "revision-guarded repository transitions match an independent state model and never partially apply a stale proposal",
  },
  {
    name: "recurrence COUNT leaks an extra occurrence",
    file: "dist/core/recurrence.js",
    from: /yielded\s*>=\s*\(rule\.count\s*\?\?\s*MAX_OCCURRENCES\)/,
    to: "if (yielded > (rule.count ?? MAX_OCCURRENCES)) return;",
    test: "tests/node/temporal/mathematical-invariants.test.mjs",
    title: "UTC daily and weekly recurrence matches an independent civil-date enumeration across leap and year boundaries",
  },
  {
    name: "prefer-local deletion sync silently applies remote",
    file: "dist/interoperability/sync.js",
    from: /if\s*\(policy === "prefer-local"\)\s*return\s*\{\s*action:\s*"delete-remote"\s*\};/,
    to: 'if (policy === "prefer-local") return { action: "apply-remote" };',
    test: "tests/node/interop/contracts.test.mjs",
    title: "sync decision model covers every local/remote deletion-change state and conflict policy",
  },
];

for (const entry of mutations) {
  const file = resolve(entry.file);
  const original = readFileSync(file, "utf8");
  const occurrences = entry.from instanceof RegExp
    ? [...original.matchAll(new RegExp(entry.from.source, "g"))].length
    : original.split(entry.from).length - 1;
  assert.equal(occurrences, 1, `${entry.name}: mutation must have precisely one canonical target`);
  const originalHash = createHash("sha256").update(original).digest("hex");
  let outcome;
  try {
    writeFileSync(file, original.replace(entry.from, entry.to));
    outcome = spawnSync(process.execPath, [
      "--test", "--test-reporter=tap", "--test-name-pattern", entry.title, entry.test,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 25_000, maxBuffer: 5 * 1024 * 1024 });
  } finally {
    writeFileSync(file, original);
  }
  assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), originalHash,
    `${entry.name}: compiled artifact restoration failed`);
  if (outcome.error) throw outcome.error;
  const output = (outcome.stdout ?? "") + (outcome.stderr ?? "");
  const expectedFailure = output.split("\n").some(line =>
    line.startsWith("not ok ") && line.includes(entry.title));
  assert.ok(outcome.status !== 0 && expectedFailure,
    `${entry.name} escaped its targeted assertion (exit ${outcome.status}).\n${output.slice(-3500)}`);
  console.log(`FAULT DETECTED: ${entry.name} -> ${entry.title}`);
}
console.log(`Mutation witnesses: ${mutations.length}/${mutations.length} independently detected and artifacts restored`);
