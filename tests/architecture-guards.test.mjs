import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import * as Calendar from "../dist/index.js";

const read = path => fs.readFile(new URL(path, import.meta.url), "utf8");
const importsOf = source => [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map(match => match[1]);

async function sourceFilesUnder(directory) {
  const files = [];
  for (const entry of await fs.readdir(new URL(directory, import.meta.url), { withFileTypes: true })) {
    const path = `${directory}${entry.name}${entry.isDirectory() ? "/" : ""}`;
    if (entry.isDirectory()) files.push(...await sourceFilesUnder(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("generic dependency direction and host-domain isolation are explicit architecture guards", async () => {
  const corePaths = [
    "../src/core/types.ts","../src/core/authority.ts","../src/core/calendar-engine.ts","../src/core/commands.ts",
    "../src/core/layout.ts","../src/core/recurrence.ts","../src/core/store.ts","../src/core/interaction.ts",
  ];
  const viewPaths = [
    "../src/view/types.ts","../src/view/calendar-ui.ts","../src/view/view-renderer.ts",
    "../src/view/gesture-controller.ts","../src/view/temporal-chrome.ts",
  ];
  const core = await Promise.all(corePaths.map(async path => [path, await read(path)]));
  const view = await Promise.all(viewPaths.map(async path => [path, await read(path)]));
  for (const [path, source] of core) {
    for (const specifier of importsOf(source)) {
      assert.doesNotMatch(specifier, /(?:^|\/)(?:view|features|storage|interoperability|integration|adapters)(?:\/|$)/, `${path} imports outward: ${specifier}`);
    }
  }
  for (const [path, source] of view) {
    for (const specifier of importsOf(source)) {
      assert.doesNotMatch(specifier, /(?:^|\/)(?:features|storage|interoperability|integration|adapters)(?:\/|$)/, `${path} imports optional/host code: ${specifier}`);
    }
  }
  const generic = [...core, ...view].map(([, source]) => source).join("\n");
  for (const token of ["Ayana","Study Director","Revision Director","Practice Desk"]) {
    assert.equal(generic.includes(token), false, `generic source leaked host domain: ${token}`);
  }
});

test("optional feature and package boundaries stay explicit", async () => {
  const pkg = JSON.parse(await read("../package.json"));
  assert.equal(Object.hasOwn(pkg.exports, "./features"), false);
  for (const subpath of [
    "./features/personal","./features/personal-ui","./features/planning","./features/availability",
    "./features/resource-scheduler","./features/resource-scheduler-ui",
  ]) assert.equal(typeof pkg.exports[subpath]?.import, "string", `missing explicit feature export ${subpath}`);
  for (const name of [
    "resolveOccurrenceCapabilities","CalendarCommandLifecycle","resolveOccurrencePresentation",
    "secondaryTimeScaleLabels","resolveNavigationBounds","createAvailabilityBackgroundProvider",
    "executeCalendarResourcePlacement",
  ]) assert.equal(Calendar[name], undefined, `${name} must remain outside the root API`);
});

test("Resource Scheduler remains optional, headless-first and renderer-separated", async () => {
  const [types, scheduler, schedulerUi, schedulerRendering, coreTypes, ordinaryView, storage] = await Promise.all([
    read("../src/features/resource-scheduler/types.ts"),
    read("../src/features/resource-scheduler/index.ts"),
    read("../src/features/resource-scheduler-ui/index.ts"),
    read("../src/features/resource-scheduler-ui/rendering.ts"),
    read("../src/core/types.ts"),
    read("../src/view/calendar-ui.ts"),
    read("../src/storage/indexeddb-repository.ts"),
  ]);
  assert.doesNotMatch(types + scheduler, /(?:\.\.\/\.\.\/)(?:view|storage|interoperability)\//);
  assert.doesNotMatch(types + scheduler, /document\.|HTMLElement|CalendarUi/);
  assert.doesNotMatch(coreTypes + ordinaryView + storage, /features\/resource-scheduler|CalendarResource/);
  assert.match(schedulerUi, /from "\.\/rendering\.js"/);
  assert.doesNotMatch(schedulerRendering, /executeCalendarResourcePlacement|mutationPort|refreshProjection|confirmWarnings/);
  assert.doesNotMatch(schedulerUi, /\.\.\/\.\.\/(?:storage|interoperability|integration|adapters)\//);
});

test("view decomposition keeps mutation, rendering and gesture concerns separated", async () => {
  const [ui, mutations, renderer, gestures, temporal] = await Promise.all([
    read("../src/view/calendar-ui.ts"),
    read("../src/view/mutation-coordinator.ts"),
    read("../src/view/view-renderer.ts"),
    read("../src/view/gesture-controller.ts"),
    read("../src/view/temporal-chrome.ts"),
  ]);
  assert.match(ui, /from "\.\/mutation-coordinator\.js"/);
  assert.match(ui, /from "\.\/view-renderer\.js"/);
  assert.match(ui, /from "\.\/gesture-controller\.js"/);
  assert.match(ui, /from "\.\/temporal-chrome\.js"/);
  for (const leaf of [mutations, renderer, gestures, temporal]) assert.doesNotMatch(leaf, /from "\.\/calendar-ui\.js"/);
  assert.doesNotMatch(mutations, /HTMLElement|document\.|querySelector|addEventListener/);
  assert.doesNotMatch(ui, /new CalendarCommandLifecycle|evaluateCalendarPlacement\(|previewPatchForCommand|resolveOccurrenceCapabilities\(/);
  assert.doesNotMatch(gestures, /CalendarCommand|commandHandler|executeCalendarPlacement/);
});

test("durable browser storage has one canonical physical database substrate", async () => {
  const [database, repository, interoperability] = await Promise.all([
    read("../src/storage/browser-database.ts"),
    read("../src/storage/indexeddb-repository.ts"),
    read("../src/interoperability/storage.ts"),
  ]);

  assert.match(database, /DEFAULT_CALENDAR_DATABASE_NAME = "director-calendar"/);
  assert.match(database, /CALENDAR_DATABASE_VERSION = 1 as const/);
  for (const store of ["calendar", "syncStates", "reminderReceipts"]) {
    assert.match(database, new RegExp(`= "${store}" as const`));
  }
  assert.match(repository, /from "\.\/browser-database\.js"/);
  assert.match(interoperability, /from "\.\.\/storage\/browser-database\.js"/);
  assert.doesNotMatch(repository + interoperability, /indexedDB\.open|director-calendar\.interop/);
  assert.match(database, /indexedDB\.open\(databaseName, CALENDAR_DATABASE_VERSION\)/);
});

test("production source contains no migration or compatibility implementation path", async () => {
  const paths = (await sourceFilesUnder("../src/"))
    .filter(path => !path.startsWith("../src/demo/") && !path.startsWith("../src/fixtures/"));
  const forbidden = /\b(?:legacy|compatibility|migrat(?:e|es|ed|ing|ion|ions))\b/iu;
  const offenders = [];
  for (const path of paths) {
    if (forbidden.test(await read(path))) offenders.push(path);
  }
  assert.deepEqual(offenders, [], `migration/compatibility implementation residue: ${offenders.join(", ")}`);
});

test("recurrence, availability and passive background dependency boundaries remain separate", async () => {
  const [recurrence, eventSeries, availability, commands, reminders, personal, presentation] = await Promise.all([
    read("../src/core/recurrence.ts"),
    read("../src/core/event-series.ts"),
    read("../src/features/availability.ts"),
    read("../src/core/commands.ts"),
    read("../src/interoperability/reminders.ts"),
    read("../src/features/personal.ts"),
    read("../src/view/presentation.ts"),
  ]);
  assert.doesNotMatch(recurrence, /CalendarItem|CalendarOccurrence/);
  assert.match(eventSeries, /expandTemporalSeries/);
  assert.doesNotMatch(availability, /CalendarItem|CalendarOccurrence|event-series/);
  for (const source of [commands, reminders, personal, presentation]) {
    assert.doesNotMatch(source, /CalendarBackgroundRange|backgroundRanges|calendarAvailability/);
  }
});

test("published package remains production-only", async () => {
  const pkg = JSON.parse(await read("../package.json"));
  assert.deepEqual(pkg.files, ["dist","docs","README.md"]);
  assert.equal(Object.hasOwn(pkg.exports, "./fixtures/director"), false);
  assert.equal(Object.hasOwn(pkg.exports, "./package-contract"), false);
});
