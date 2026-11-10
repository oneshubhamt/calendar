import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const read = path => fs.readFile(new URL(path, import.meta.url), "utf8");

test("R1 exposes Resource Scheduler only through its explicit optional package subpath", async () => {
  const pkg = JSON.parse(await read("../package.json"));
  assert.equal(Object.hasOwn(pkg.exports, "./features"), false);
  assert.deepEqual(pkg.exports["./features/resource-scheduler"], {
    types: "./dist/features/resource-scheduler/index.d.ts",
    import: "./dist/features/resource-scheduler/index.js",
  });

  const module = await import("../dist/features/resource-scheduler/index.js");
  assert.deepEqual(Object.keys(module).sort(), [
    "associateCalendarResources", "flattenCalendarResources", "layoutResourceTimeline",
    "validateCalendarResourceAssignments", "validateCalendarResources",
  ].sort(), "only explicit optional R2 pure mechanics may be exported at runtime");
});

test("R1 Resource Scheduler contracts depend only on core types", async () => {
  const source = await read("../src/features/resource-scheduler/index.ts");
  for (const contract of [
    "CalendarResourceDisplay",
    "CalendarResource",
    "CalendarResourceProvider",
    "CalendarResourceAssignment",
    "CalendarResourceAssignmentProvider",
    "CalendarResourceCapabilities",
    "CalendarResourceCapabilityProvider",
    "CalendarResourcePlacementContext",
    "CalendarResourcePlacementGuard",
    "CalendarResourcePlacementChange",
    "CalendarResourceMutationPort",
  ]) {
    assert.match(source, new RegExp(`export interface ${contract}\\b`), `missing R1 contract: ${contract}`);
  }
  assert.match(source, /CalendarResourceAssignmentVersion = CalendarOpaqueIdentity/);
  assert.match(source, /projectResources\([\s\S]*range: CalendarRange/);
  assert.match(source, /projectAssignments\([\s\S]*range: CalendarRange,[\s\S]*occurrences: readonly CalendarOccurrence\[\]/);
  assert.doesNotMatch(source, /\.\.\/\.\.\/(view|storage|interoperability)\//);
  assert.doesNotMatch(source, /document\.|HTMLElement|CalendarUiAddon/);
});

test("R1 keeps root, core and ordinary view resource-free", async () => {
  const paths = [
    "../src/index.ts",
    "../src/core/index.ts",
    "../src/core/types.ts",
    "../src/core/layout.ts",
    "../src/core/interaction.ts",
    "../src/core/authority.ts",
    "../src/core/calendar-engine.ts",
    "../src/view/index.ts",
    "../src/view/types.ts",
    "../src/view/calendar-ui.ts",
  ];
  const entries = await Promise.all(paths.map(async path => [path, await read(path)]));

  for (const [path, source] of entries) {
    assert.doesNotMatch(source, /features\/resource-scheduler|CalendarResource/, `${path} leaked Resource Scheduler`);
  }

  const coreTypes = entries.find(([path]) => path === "../src/core/types.ts")[1];
  assert.doesNotMatch(coreTypes, /\bresourceIds?\b/);
  assert.doesNotMatch(coreTypes, /resourceTimeline/);

  const layout = entries.find(([path]) => path === "../src/core/layout.ts")[1];
  const timed = layout.match(/export function layoutTimedDay\([\s\S]*?\n}/)?.[0] ?? "";
  assert.match(timed, /readonly CalendarOccurrence\[\]/);
  assert.doesNotMatch(timed, /resource/i);
});

test("R1 documents the programme without claiming R2+ mechanics", async () => {
  const [programme, architecture] = await Promise.all([
    read("../docs/RESOURCE_SCHEDULER_PROGRAMME.md"),
    read("../docs/ARCHITECTURE.md"),
  ]);
  assert.match(programme, /R1 intentionally contains no hierarchy validation/);
  assert.match(programme, /R7 — Independent closure audit and QA/);
  assert.match(architecture, /### `features\/resource-scheduler`/);
  assert.match(architecture, /combined time\/resource drag must never become two independent writes/);
});
