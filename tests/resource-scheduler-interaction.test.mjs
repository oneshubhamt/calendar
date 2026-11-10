import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  replaceCalendarResourceAssignment,
} from "../dist/features/resource-scheduler/index.js";
import {
  moveResourceOccurrenceByCivilMinutes,
  resizeResourceOccurrenceByCivilMinutes,
  snapResourceInteractionMinutes,
} from "../dist/features/resource-scheduler-ui/interaction.js";

const read = path => fs.readFile(new URL(path, import.meta.url), "utf8");

function occurrence(overrides={}){
  return {
    occurrenceId:"occ",sourceItemId:"item",calendarId:"calendar",title:"Visit",
    start:"2026-11-10T09:00:00.000Z",end:"2026-11-10T10:00:00.000Z",
    originalStart:"2026-11-10T09:00:00.000Z",recurring:false,
    kind:"event",ownership:"host",editPolicy:"full",...overrides,
  };
}

test("R6 replacing one rendered multi-resource assignment preserves every unrelated assignment",()=>{
  assert.deepEqual(replaceCalendarResourceAssignment(["room-a","doctor","device"],"room-a","room-b"),[
    "room-b","doctor","device",
  ]);
  assert.deepEqual(replaceCalendarResourceAssignment(["room-a","doctor"],"room-a","doctor"),["doctor"]);
  assert.deepEqual(replaceCalendarResourceAssignment(["room-a","doctor"],"room-a","room-a"),["room-a","doctor"]);
  assert.throws(()=>replaceCalendarResourceAssignment(["doctor"],"room-a","room-b"),/exactly once/i);
  assert.throws(()=>replaceCalendarResourceAssignment(["room-a","room-a"],"room-a","room-b"),/exactly once/i);
});

test("R6 interaction math reuses civil DST semantics and keeps point moves zero-duration",()=>{
  assert.equal(snapResourceInteractionMinutes(22,15),15);
  assert.equal(snapResourceInteractionMinutes(23,15),30);
  const moved=moveResourceOccurrenceByCivilMinutes(occurrence(),30,"UTC","earlier");
  assert.deepEqual(moved,{start:"2026-11-10T09:30:00.000Z",end:"2026-11-10T10:30:00.000Z"});
  const point=occurrence({start:"2026-11-10T09:00:00.000Z",end:"2026-11-10T09:00:00.000Z",temporalForm:"point"});
  assert.deepEqual(moveResourceOccurrenceByCivilMinutes(point,15,"UTC","earlier"),{
    start:"2026-11-10T09:15:00.000Z",end:"2026-11-10T09:15:00.000Z",
  });
  const spring=occurrence({start:"2026-03-08T06:30:00.000Z",end:"2026-03-08T07:30:00.000Z"});
  assert.equal(moveResourceOccurrenceByCivilMinutes(spring,30,"America/New_York","earlier"),null,
    "01:30 + 30 civil minutes targets the spring-forward gap and must fail closed");
});

test("R6 resize math uses core interval constraints and refuses point resize",()=>{
  const resized=resizeResourceOccurrenceByCivilMinutes(occurrence(),"end",-50,15,"UTC","earlier");
  assert.deepEqual(resized,{start:"2026-11-10T09:00:00.000Z",end:"2026-11-10T09:15:00.000Z"});
  const point=occurrence({start:"2026-11-10T09:00:00.000Z",end:"2026-11-10T09:00:00.000Z",temporalForm:"point"});
  assert.equal(resizeResourceOccurrenceByCivilMinutes(point,"end",15,5,"UTC","earlier"),null);
});

test("R6 UI wires pointer/touch drag, diagonal reassignment, resize and keyboard equivalents only through R5",async()=>{
  const [ui,styles]=await Promise.all([
    read("../src/features/resource-scheduler-ui/index.ts"),
    read("../src/features/resource-scheduler-ui/styles.ts"),
  ]);
  for(const token of [
    "executeCalendarResourcePlacement","replaceCalendarResourceAssignment",
    "setPointerCapture","pointermove","pointerup","pointercancel",
    "resourceAt(clientY)","resource-time-move","resize-start","resize-end",
    "Alt+Left/Right","Alt+Up/Down","refreshAuthoritativeProjection",
    "aria-busy","aria-live","dc-rs-drag-ghost",
  ]) assert.equal(ui.includes(token),true,`missing R6 interaction token: ${token}`);
  assert.match(styles,/\.dc-rs-event\.is-interactive\{[^}]*touch-action:none/);
  assert.match(styles,/\.dc-rs-resize-handle\{[^}]*touch-action:none/);
  assert.match(styles,/\.dc-rs-drag-ghost\{[^}]*pointer-events:none/);
  assert.equal((ui.match(/executeCalendarResourcePlacement\(/g)??[]).length,2,
    "warning acceptance deliberately re-evaluates through the same R5 executor, never a second mutation API");
  assert.doesNotMatch(ui,/mutationPort\.commit\(|evaluateCalendarPlacement\(|resolveOccurrenceCapabilities\(/);
});

test("R6 keeps read-only behavior when interaction config is absent and host projection remains authoritative",async()=>{
  const ui=await read("../src/features/resource-scheduler-ui/index.ts");
  assert.match(ui,/if \(!this\.interaction/);
  assert.match(ui,/const refreshed = await this\.interaction\?\.refreshProjection\?\.\(\)/);
  assert.match(ui,/if \(refreshed\) this\.setProjection\(refreshed\)/);
  assert.doesNotMatch(ui,/this\.projection\.(?:assignments|occurrences)\s*=/);
  assert.doesNotMatch(ui,/splice\(|push\([^\n]*projection/);
});

test("R6 recurrence scope and interaction configuration fail closed",async()=>{
  const placement=await read("../src/features/resource-scheduler/placement.ts");
  const ui=await read("../src/features/resource-scheduler-ui/index.ts");
  assert.match(placement,/Resource placement recurrence scope is invalid/);
  assert.match(ui,/occurrence\.recurring && interaction\.resolveScope/);
  assert.match(ui,/scope: SeriesEditScope \| null = "this"/);
  assert.match(ui,/\["this", "this-and-following", "all"\]\.includes\(scope\)/);
  assert.match(ui,/dstOverlapDisambiguation/);
  assert.match(ui,/minimumDurationMinutes/);
  assert.match(ui,/snapMinutes/);
});

test("R6 does not leak Resource Scheduler interaction into ordinary Calendar, core or persistence",async()=>{
  const [ui,core,view,root]=await Promise.all([
    read("../src/features/resource-scheduler-ui/index.ts"),
    read("../src/core/types.ts"),
    read("../src/view/calendar-ui.ts"),
    read("../src/index.ts"),
  ]);
  assert.doesNotMatch(core,/CalendarResource|resourceTimeline|\bresourceIds?\b/);
  assert.doesNotMatch(view,/CalendarResource|resource-scheduler/);
  assert.doesNotMatch(root,/CalendarResourceScheduler|resource-scheduler/);
  assert.doesNotMatch(ui,/\.\.\/\.\.\/(storage|interoperability)\//);
});
