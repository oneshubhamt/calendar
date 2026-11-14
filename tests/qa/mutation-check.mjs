import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { mutationCases } from "./mutation-cases.mjs";

const ids = new Set();
for (const entry of mutationCases) {
  assert.equal(ids.has(entry.id), false, `Duplicate mutation id: ${entry.id}`);
  ids.add(entry.id);
  assert.ok(entry.invariantIds.length > 0, `${entry.id}: mutation must name at least one invariant`);

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
  console.log(`FAULT DETECTED [${entry.id}]: ${entry.name} -> ${entry.title}`);
}
console.log(`Mutation witnesses: ${mutationCases.length}/${mutationCases.length} independently detected and artifacts restored`);
