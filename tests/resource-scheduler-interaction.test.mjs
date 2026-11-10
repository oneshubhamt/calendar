import test from "node:test";
import assert from "node:assert/strict";
import {
  replaceCalendarResourceAssignment,
} from "../dist/features/resource-scheduler/index.js";
import {
  moveResourceOccurrenceByCivilMinutes,
  resizeResourceOccurrenceByCivilMinutes,
} from "../dist/features/resource-scheduler-ui/interaction.js";
import { snapMinuteCoordinate } from "../dist/index.js";

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
  assert.throws(()=>replaceCalendarResourceAssignment(["room-a","room-a"],"room-a","room-b"),/duplicate resource/i);
});

test("R6 interaction math reuses civil DST semantics and keeps point moves zero-duration",()=>{
  assert.equal(snapMinuteCoordinate(22,15,"round"),15);
  assert.equal(snapMinuteCoordinate(23,15,"round"),30);
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
