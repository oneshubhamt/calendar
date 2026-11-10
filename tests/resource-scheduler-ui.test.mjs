import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const read = path => fs.readFile(new URL(path, import.meta.url), "utf8");

test("R4 exposes a separate optional Resource Scheduler UI subpath without widening root/core/view", async()=>{
  const pkg=JSON.parse(await read("../package.json"));
  assert.deepEqual(pkg.exports["./features/resource-scheduler-ui"],{
    types:"./dist/features/resource-scheduler-ui/index.d.ts",
    import:"./dist/features/resource-scheduler-ui/index.js",
  });
  assert.equal(Object.hasOwn(pkg.exports,"./features"),false);
  const ui=await import("../dist/features/resource-scheduler-ui/index.js");
  assert.equal(typeof ui.CalendarResourceSchedulerUi,"function");
  assert.equal(typeof ui.RESOURCE_SCHEDULER_CSS,"string");

  const [root,coreTypes,viewTypes,view]=await Promise.all([
    read("../src/index.ts"),read("../src/core/types.ts"),read("../src/view/types.ts"),read("../src/view/calendar-ui.ts"),
  ]);
  for(const [name,source] of [["root",root],["core",coreTypes],["view types",viewTypes],["CalendarUi",view]]) {
    assert.doesNotMatch(source,/resource-scheduler-ui|CalendarResourceSchedulerUi/,name);
  }
  assert.doesNotMatch(coreTypes,/resourceTimeline|\bresourceIds?\b/);
});

test("R4 is a standalone data-driven read-only surface, not an add-on or second engine",async()=>{
  const source=await read("../src/features/resource-scheduler-ui/index.ts");
  assert.match(source,/export class CalendarResourceSchedulerUi/);
  assert.match(source,/setProjection\(projection: CalendarResourceSchedulerProjection\)/);
  assert.match(source,/layoutResourceTimeline/);
  assert.match(source,/flattenCalendarResources/);
  assert.match(source,/resolveOccurrencePresentation/);
  for(const forbidden of [
    "CalendarUiAddon","new CalendarUi","CalendarEngine","CalendarRepository",
    "evaluateCalendarPlacement","CalendarResourceMutationPort","CalendarResourceCapabilityProvider",
    "expandItem","expandTemporalSeries","projectResources(","projectAssignments(",
  ]) assert.equal(source.includes(forbidden),false,`R4 leaked forbidden behavior: ${forbidden}`);
  assert.doesNotMatch(source,/\.\.\/\.\.\/(storage|interoperability)\//);
});

test("R4 DOM contract contains hierarchy, empty rows, scroll, time axis and accessibility/keyboard foundations",async()=>{
  const [source,styles]=await Promise.all([
    read("../src/features/resource-scheduler-ui/index.ts"),
    read("../src/features/resource-scheduler-ui/styles.ts"),
  ]);
  for(const token of [
    'role", "treegrid"','role", "row"','role", "rowheader"','role", "gridcell"',
    '"aria-level"','"aria-expanded"','dc-rs-axis','dc-rs-resource-row',
    'No resources in this range.','scrollIntoView',
    '"ArrowLeft"','"ArrowRight"','"ArrowUp"','"ArrowDown"','"Home"','"End"',
  ]) assert.equal(source.includes(token),true,`missing R4 UI contract token: ${token}`);
  assert.match(styles,/\.dc-rs-scroll\{[^}]*overflow:auto/);
  assert.match(styles,/touch-action:pan-x pan-y/);
  assert.match(styles,/\.dc-rs-row-header\{[^}]*position:sticky/);
  assert.match(styles,/\.dc-rs-header-row\{[^}]*position:sticky/);
  assert.match(styles,/:focus-visible/);
  assert.match(styles,/prefers-reduced-motion/);
});

test("R4 keeps minimum visual sizes in UI rather than corrupting R3 mathematical geometry",async()=>{
  const [ui,layout]=await Promise.all([
    read("../src/features/resource-scheduler-ui/index.ts"),
    read("../src/features/resource-scheduler/timeline-layout.ts"),
  ]);
  assert.match(ui,/Math\.max\(18, layout\.widthMinutes \* scale\)/);
  assert.match(ui,/layout\.temporalForm === "point" \? 10/);
  assert.doesNotMatch(layout,/Math\.max\(18|MIN_EVENT|minimum pixel/i);
  assert.match(layout,/resolveResourceTimelineRangeGeometry/);
});

test("R4 documentation preserves the read-only tranche boundary before R5 writes",async()=>{
  const programme=await read("../docs/RESOURCE_SCHEDULER_PROGRAMME.md");
  const architecture=await read("../docs/ARCHITECTURE.md");
  assert.match(programme,/R4 implementation notes/);
  assert.match(programme,/drag\/reassignment\/resize remain deferred to R6/);
  assert.match(programme,/does not query providers, expand recurrence, interpret resource policy, invoke authority, persist data or perform mutation/);
  assert.match(architecture,/data-driven read-only surface/);
  assert.match(architecture,/does not add a `CalendarView` member/);
});
