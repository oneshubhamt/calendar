import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import * as Calendar from "../dist/index.js";
import * as CalendarCore from "../dist/core/index.js";
import { loadSourceModuleGraph } from "./helpers/module-graph.mjs";

const read = path => fs.readFile(new URL(path, import.meta.url), "utf8");
const graphPromise = loadSourceModuleGraph(new URL("../src/", import.meta.url));

const idsUnder = (graph, prefix) => [...graph.keys()].filter(id => id.startsWith(prefix));
const dependenciesOf = (graph, id) => graph.get(id)?.imports ?? new Set();

function assertNoDependenciesInto(graph, ids, forbiddenPrefixes) {
  for (const id of ids) {
    for (const dependency of dependenciesOf(graph, id)) {
      assert.equal(
        forbiddenPrefixes.some(prefix => dependency.startsWith(prefix)),
        false,
        `${id} must not depend on ${dependency}`,
      );
    }
  }
}

function assertHasDependency(graph, id, expected) {
  assert.equal(dependenciesOf(graph, id).has(expected), true, `${id} must depend on ${expected}`);
}

test("module graph enforces generic dependency direction", async () => {
  const graph = await graphPromise;
  for (const id of idsUnder(graph, "core/")) {
    for (const dependency of dependenciesOf(graph, id)) {
      assert.equal(dependency.startsWith("core/"), true, `${id} imports outward: ${dependency}`);
    }
  }
  for (const id of idsUnder(graph, "view/")) {
    for (const dependency of dependenciesOf(graph, id)) {
      assert.equal(
        dependency.startsWith("core/") || dependency.startsWith("view/"),
        true,
        `${id} imports optional or host code: ${dependency}`,
      );
    }
  }
  assert.deepEqual([...dependenciesOf(graph, "index.ts")].sort(), ["core/index.ts", "view/index.ts"]);
});

test("optional features and package entry points remain explicit contracts", async () => {
  const pkg = JSON.parse(await read("../package.json"));
  assert.equal(Object.hasOwn(pkg.exports, "./features"), false);
  for (const subpath of [
    "./features/personal", "./features/personal-ui", "./features/planning", "./features/availability",
    "./features/resource-scheduler", "./features/resource-scheduler-ui", "./features/resource-availability",
    "./features/resource-time-grid", "./features/resource-time-grid-ui", "./view/multi-month", "./view/timeline",
  ]) {
    assert.equal(typeof pkg.exports[subpath]?.import, "string", `missing explicit feature export ${subpath}`);
    assert.equal(typeof pkg.exports[subpath]?.types, "string", `missing explicit type export ${subpath}`);
  }
  for (const name of [
    "resolveOccurrenceCapabilities", "CalendarCommandLifecycle", "resolveOccurrencePresentation", "CalendarViewRegistry",
    "secondaryTimeScaleLabels", "resolveNavigationBounds", "createAvailabilityBackgroundProvider",
    "executeCalendarResourcePlacement", "executeCalendarResourceInteraction", "layoutResourceTimeGrid",
    "partitionOverlapLanes", "createMultiMonthView", "createTimelineView",
  ]) assert.equal(Calendar[name], undefined, `${name} must remain outside the root API`);
  assert.equal(CalendarCore.partitionOverlapLanes, undefined, "visual lane partitioning must remain internal");
});

test("Resource Scheduler and Resource TimeGrid remain optional graph islands", async () => {
  const graph = await graphPromise;
  const headless = [
    ...idsUnder(graph, "features/resource-scheduler/"),
    ...idsUnder(graph, "features/resource-time-grid/"),
    "features/resource-availability.ts",
    "features/resource-interaction-lifecycle.ts",
  ];
  assertNoDependenciesInto(graph, headless, ["view/", "storage/", "interoperability/", "integration/", "adapters/"]);
  assertNoDependenciesInto(
    graph,
    [...idsUnder(graph, "features/resource-scheduler-ui/"), ...idsUnder(graph, "features/resource-time-grid-ui/")],
    ["storage/", "interoperability/", "integration/", "adapters/"],
  );
  assertNoDependenciesInto(graph, ["features/resource-scheduler/index.ts"], ["features/resource-availability", "features/resource-time-grid/"]);
  assertNoDependenciesInto(graph, ["core/horizontal-timeline.ts", "view/pointer-gesture.ts"], ["features/resource-scheduler", "features/resource-time-grid"]);
});

test("Google interoperability layering is expressed by module dependencies", async () => {
  const graph = await graphPromise;
  assertNoDependenciesInto(graph, ["interoperability/google-transport.ts"], ["interoperability/google-mapping.ts", "interoperability/google-sync.ts"]);
  assertNoDependenciesInto(graph, ["interoperability/google-mapping.ts"], ["interoperability/google-sync.ts"]);
  assertHasDependency(graph, "interoperability/google-sync.ts", "interoperability/google-transport.ts");
  assertHasDependency(graph, "interoperability/google-sync.ts", "interoperability/google-mapping.ts");
});

test("durable browser persistence converges on one database substrate", async () => {
  const graph = await graphPromise;
  assertHasDependency(graph, "storage/indexeddb-repository.ts", "storage/browser-database.ts");
  assertHasDependency(graph, "interoperability/storage.ts", "storage/browser-database.ts");
  assertNoDependenciesInto(graph, idsUnder(graph, "storage/"), ["view/", "features/", "integration/", "adapters/"]);
});

test("recurrence, availability, external-drop and background boundaries stay one-way", async () => {
  const graph = await graphPromise;
  assertNoDependenciesInto(graph, ["features/availability.ts"], ["core/event-series.ts", "view/", "storage/", "interoperability/", "integration/", "adapters/"]);
  assertNoDependenciesInto(
    graph,
    ["core/commands.ts", "interoperability/reminders.ts", "features/personal.ts", "view/presentation.ts"],
    ["features/availability.ts", "features/resource-availability.ts"],
  );
  assertNoDependenciesInto(graph, ["view/external-drop.ts"], ["storage/", "interoperability/", "integration/", "adapters/"]);
  assertNoDependenciesInto(graph, [...idsUnder(graph, "storage/"), ...idsUnder(graph, "interoperability/")], ["view/external-drop.ts"]);
});

test("published package contract remains production-only", async () => {
  const pkg = JSON.parse(await read("../package.json"));
  assert.deepEqual(pkg.files, ["dist", "docs/ARCHITECTURE.md", "README.md"]);
  assert.equal(Object.hasOwn(pkg.exports, "./fixtures/director"), false);
  assert.equal(Object.hasOwn(pkg.exports, "./package-contract"), false);
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    assert.equal(typeof target?.import, "string", `${subpath} must publish an import target`);
    assert.equal(typeof target?.types, "string", `${subpath} must publish a type target`);
    assert.equal(target.import.startsWith("./dist/"), true, `${subpath} import must come from dist`);
    assert.equal(target.types.startsWith("./dist/"), true, `${subpath} types must come from dist`);
  }
});
