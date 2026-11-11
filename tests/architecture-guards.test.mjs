import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import * as Calendar from "../dist/index.js";
import * as CalendarCore from "../dist/core/index.js";

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
    "../src/core/layout.ts","../src/core/visual-lanes.ts","../src/core/horizontal-timeline.ts","../src/core/recurrence.ts","../src/core/store.ts","../src/core/interaction.ts",
  ];
  const viewPaths = [
    "../src/view/types.ts","../src/view/calendar-ui.ts","../src/view/view-renderer.ts","../src/view/view-registry.ts",
    "../src/view/month-panel.ts","../src/view/render-primitives.ts","../src/view/week-numbering.ts","../src/view/multi-month.ts","../src/view/timeline.ts",
    "../src/view/external-drop.ts","../src/view/pointer-gesture.ts","../src/view/gesture-controller.ts","../src/view/temporal-chrome.ts",
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
    "./features/resource-scheduler","./features/resource-scheduler-ui","./view/multi-month","./view/timeline",
  ]) assert.equal(typeof pkg.exports[subpath]?.import, "string", `missing explicit feature export ${subpath}`);
  for (const name of [
    "resolveOccurrenceCapabilities","CalendarCommandLifecycle","resolveOccurrencePresentation","CalendarViewRegistry",
    "secondaryTimeScaleLabels","resolveNavigationBounds","createAvailabilityBackgroundProvider",
    "executeCalendarResourcePlacement","partitionOverlapLanes","createMultiMonthView","createTimelineView",
  ]) assert.equal(Calendar[name], undefined, `${name} must remain outside the root API`);
  assert.equal(CalendarCore.partitionOverlapLanes, undefined, "visual lane partitioning must remain internal to core implementation");
});

test("Resource Scheduler remains optional and reuses generic timeline/gesture mechanics", async () => {
  const [types, scheduler, schedulerLayout, schedulerUi, schedulerRendering, coreTypes, timelineCore, pointerGestures, ordinaryView, storage] = await Promise.all([
    read("../src/features/resource-scheduler/types.ts"),
    read("../src/features/resource-scheduler/index.ts"),
    read("../src/features/resource-scheduler/timeline-layout.ts"),
    read("../src/features/resource-scheduler-ui/index.ts"),
    read("../src/features/resource-scheduler-ui/rendering.ts"),
    read("../src/core/types.ts"),
    read("../src/core/horizontal-timeline.ts"),
    read("../src/view/pointer-gesture.ts"),
    read("../src/view/calendar-ui.ts"),
    read("../src/storage/indexeddb-repository.ts"),
  ]);
  assert.doesNotMatch(types + scheduler, /(?:\.\.\/\.\.\/)(?:view|storage|interoperability)\//);
  assert.doesNotMatch(types + scheduler, /document\.|HTMLElement|CalendarUi/);
  assert.doesNotMatch(coreTypes + ordinaryView + storage, /features\/resource-scheduler|CalendarResource/);
  assert.match(schedulerLayout, /layoutHorizontalTimeline/);
  assert.doesNotMatch(schedulerLayout, /civilMinuteOfInstant|partitionOverlapLanes|function visualOverlap/);
  assert.match(schedulerRendering, /horizontalTimelineTicks/);
  assert.match(schedulerUi, /CalendarPointerGestureController/);
  assert.match(pointerGestures, /requestAnimationFrame/);
  assert.doesNotMatch(schedulerUi, /requestAnimationFrame|AUTO_SCROLL_ZONE|AUTO_SCROLL_STEP/);
  assert.match(schedulerUi, /from "\.\/rendering\.js"/);
  assert.doesNotMatch(schedulerRendering, /executeCalendarResourcePlacement|mutationPort|refreshProjection|confirmWarnings/);
  assert.doesNotMatch(schedulerUi, /\.\.\/\.\.\/(?:storage|interoperability|integration|adapters)\//);
  assert.doesNotMatch(timelineCore + pointerGestures, /CalendarResource|resource-scheduler/);
});

test("custom view extensibility remains view-layer only and mutation-safe", async () => {
  const [coreTypes, viewTypes, registry, ui, multiMonth, timeline, viewIndex, rootIndex, storage] = await Promise.all([
    read("../src/core/types.ts"),
    read("../src/view/types.ts"),
    read("../src/view/view-registry.ts"),
    read("../src/view/calendar-ui.ts"),
    read("../src/view/multi-month.ts"),
    read("../src/view/timeline.ts"),
    read("../src/view/index.ts"),
    read("../src/index.ts"),
    read("../src/storage/indexeddb-repository.ts"),
  ]);

  assert.doesNotMatch(coreTypes, /CalendarCustomView|CalendarUiViewId|customViews/);
  assert.match(viewTypes, /interface CalendarCustomViewPlugin/);
  assert.match(viewTypes, /interface CalendarCustomViewActionPort/);
  assert.match(viewTypes, /interface CalendarCustomViewRenderPort/);
  assert.match(viewTypes, /weekNumbering\?: CalendarResolvedWeekNumbering/);
  assert.match(viewTypes, /renderers: CalendarCustomViewRenderPort/);
  assert.doesNotMatch(viewTypes, /CalendarRepository|IndexedDb|SyncState|GoogleCalendar/);
  assert.doesNotMatch(registry, /storage|interoperability|integration|adapters|CalendarRepository/);
  assert.match(ui, /new CalendarViewRegistry/);
  assert.match(ui, /weekNumbering: this\.weekNumbering/);
  assert.match(ui, /renderers: this\.customViewRenderers\(\)/);
  assert.match(ui, /monthPanel: \(monthStart: Date\)/);
  assert.match(ui, /Month panel must be contained within the active custom view range/);
  assert.match(ui, /body\.append\(this\.renderActiveView\(\)\)/);
  assert.doesNotMatch(ui, /if \(this\.view === "month"\) body\.append|else if \(this\.view === "year"\) body\.append/);
  assert.match(multiMonth, /context\.renderers\.monthPanel\(monthStart\)/);
  assert.doesNotMatch(multiMonth, /dc-day-cell|groupByDay|bindExternalDropTarget|CalendarRepository|storage|interoperability/);
  assert.match(timeline, /layoutHorizontalTimeline/);
  assert.match(timeline, /CalendarPointerGestureController/);
  assert.match(timeline, /context\.actions\.bindExternalDropTarget/);
  assert.doesNotMatch(timeline, /CalendarResource|resource-scheduler|CalendarRepository|storage|interoperability/);
  assert.doesNotMatch(ui, /from "\.\/(?:multi-month|timeline)\.js"/);
  assert.doesNotMatch(viewIndex + rootIndex, /multi-month|timeline/);
  assert.doesNotMatch(storage, /CalendarCustomView|CalendarUiViewId/);
});

test("external drop remains a view-layer creation boundary rather than a persistence path", async () => {
  const [coreTypes, viewTypes, externalDrop, ui, storage, interop] = await Promise.all([
    read("../src/core/types.ts"),
    read("../src/view/types.ts"),
    read("../src/view/external-drop.ts"),
    read("../src/view/calendar-ui.ts"),
    read("../src/storage/indexeddb-repository.ts"),
    read("../src/interoperability/storage.ts"),
  ]);

  assert.doesNotMatch(coreTypes, /ExternalDrop|DataTransfer/);
  assert.match(viewTypes, /externalDropDecoder/);
  assert.match(viewTypes, /dropExternal\(dataTransfer: DataTransfer \| null, selection: CalendarSelection\)/);
  assert.match(externalDrop, /CALENDAR_EXTERNAL_DROP_MIME/);
  assert.match(externalDrop, /bindCalendarExternalDropTarget/);
  assert.doesNotMatch(externalDrop, /CalendarRepository|IndexedDb|SyncState|GoogleCalendar|commandHandler/);
  assert.match(ui, /createCalendarItem\(draft, "external-drop"\)/);
  assert.match(ui, /mutations\.allowDraftPlacement\(item, undefined, "external-drop"\)/);
  assert.match(ui, /mutations\.dispatch\(\{ type: "create", item \}\)/);
  assert.doesNotMatch(storage + interop, /ExternalDrop|DataTransfer/);
});

test("view decomposition keeps mutation, rendering and gesture concerns separated", async () => {
  const [ui, mutations, occurrenceForm, renderer, monthPanel, renderPrimitives, pointerGestures, gestures, temporal] = await Promise.all([
    read("../src/view/calendar-ui.ts"),
    read("../src/view/mutation-coordinator.ts"),
    read("../src/view/occurrence-form.ts"),
    read("../src/view/view-renderer.ts"),
    read("../src/view/month-panel.ts"),
    read("../src/view/render-primitives.ts"),
    read("../src/view/pointer-gesture.ts"),
    read("../src/view/gesture-controller.ts"),
    read("../src/view/temporal-chrome.ts"),
  ]);
  assert.match(ui, /from "\.\/mutation-coordinator\.js"/);
  assert.match(ui, /from "\.\/view-renderer\.js"/);
  assert.match(ui, /from "\.\/gesture-controller\.js"/);
  assert.match(ui, /from "\.\/temporal-chrome\.js"/);
  for (const leaf of [mutations, occurrenceForm, renderer, monthPanel, renderPrimitives, pointerGestures, gestures, temporal]) {
    assert.doesNotMatch(leaf, /from "\.\/calendar-ui\.js"/);
  }
  assert.match(ui, /from "\.\/occurrence-form\.js"/);
  assert.match(mutations, /from "\.\/occurrence-form\.js"/);
  assert.match(monthPanel, /from "\.\/occurrence-form\.js"/);
  assert.match(renderer, /from "\.\/month-panel\.js"/);
  assert.match(renderer, /renderMonthPanel\(model, actions/);
  assert.doesNotMatch(renderer, /dc-day-cell|bindExternalDropTarget\(cell/);
  assert.match(monthPanel, /dc-day-cell/);
  assert.match(monthPanel, /bindExternalDropTarget\(cell/);
  assert.match(monthPanel, /openMonthOverflow/);
  assert.match(monthPanel, /groupAllDayBackgroundRangesByDay/);
  assert.match(monthPanel, /options\.range/);
  assert.doesNotMatch(monthPanel, /model\.visibleRange/);
  assert.doesNotMatch(mutations, /HTMLElement|document\.|querySelector|addEventListener/);
  assert.doesNotMatch(ui, /new CalendarCommandLifecycle|evaluateCalendarPlacement\(|previewPatchForCommand|resolveOccurrenceCapabilities\(|private issueOccurrencePatch|private issueTimedCommand|private dispatchOccurrence/);
  assert.match(gestures, /CalendarPointerGestureController/);
  assert.doesNotMatch(gestures, /requestAnimationFrame|armTouchDrag|armPointerDrag/);
  assert.doesNotMatch(gestures + pointerGestures, /CalendarCommand|commandHandler|executeCalendarPlacement/);
});

test("Google interoperability keeps transport, mapping and sync responsibilities behind one public facade", async () => {
  const [facade, transport, mapping, sync] = await Promise.all([
    read("../src/interoperability/google-calendar.ts"),
    read("../src/interoperability/google-transport.ts"),
    read("../src/interoperability/google-mapping.ts"),
    read("../src/interoperability/google-sync.ts"),
  ]);

  assert.doesNotMatch(facade, /class |function |fetch\(|navigator\.|CalendarRepository/);
  assert.match(facade, /from "\.\/google-transport\.js"/);
  assert.match(facade, /from "\.\/google-mapping\.js"/);
  assert.match(facade, /from "\.\/google-sync\.js"/);
  assert.doesNotMatch(transport, /google-(?:mapping|sync)\.js/);
  assert.doesNotMatch(mapping, /google-sync\.js/);
  assert.match(sync, /from "\.\/google-transport\.js"/);
  assert.match(sync, /from "\.\/google-mapping\.js"/);
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
  assert.match(database, /indexedDB\.open\(DEFAULT_CALENDAR_DATABASE_NAME, CALENDAR_DATABASE_VERSION\)/);
  assert.doesNotMatch(repository + interoperability, /\bdatabaseName\b|\bdbName\b/);
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
  assert.deepEqual(pkg.files, ["dist","docs/ARCHITECTURE.md","README.md"]);
  assert.equal(Object.hasOwn(pkg.exports, "./fixtures/director"), false);
  assert.equal(Object.hasOwn(pkg.exports, "./package-contract"), false);
});
