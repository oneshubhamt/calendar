import test from "node:test";
import assert from "node:assert/strict";
import {
  executeCalendarResourceInteraction,
  replaceCalendarResourceAssignment,
} from "../dist/features/resource-scheduler/index.js";
import {
  moveOccurrenceByCivilMinutes,
  resizeOccurrenceByCivilMinutes,
  snapMinuteCoordinate,
} from "../dist/index.js";
import { makeResourceOccurrence } from "./fixtures/domain.mjs";

const occurrence = makeResourceOccurrence;

test("replacing one rendered multi-resource assignment preserves every unrelated assignment",()=>{
  assert.deepEqual(replaceCalendarResourceAssignment(["room-a","doctor","device"],"room-a","room-b"),[
    "room-b","doctor","device",
  ]);
  assert.deepEqual(replaceCalendarResourceAssignment(["room-a","doctor"],"room-a","doctor"),["doctor"]);
  assert.deepEqual(replaceCalendarResourceAssignment(["room-a","doctor"],"room-a","room-a"),["room-a","doctor"]);
  assert.throws(()=>replaceCalendarResourceAssignment(["doctor"],"room-a","room-b"),/exactly once/i);
  assert.throws(()=>replaceCalendarResourceAssignment(["room-a","room-a"],"room-a","room-b"),/duplicate resource/i);
});

test("interaction math reuses civil DST semantics and keeps point moves zero-duration",()=>{
  assert.equal(snapMinuteCoordinate(22,15,"round"),15);
  assert.equal(snapMinuteCoordinate(23,15,"round"),30);
  const moved=moveOccurrenceByCivilMinutes(occurrence(),30,"UTC","earlier");
  assert.deepEqual(moved,{start:"2026-11-10T09:30:00.000Z",end:"2026-11-10T10:30:00.000Z"});

  const overnight=occurrence({
    start:"2026-11-10T23:30:00.000Z",end:"2026-11-11T00:30:00.000Z",
  });
  assert.deepEqual(moveOccurrenceByCivilMinutes(overnight,60,"UTC","earlier"),{
    start:"2026-11-11T00:30:00.000Z",end:"2026-11-11T01:30:00.000Z",
  });

  const beforeFold=occurrence({
    start:"2026-11-01T04:30:00.000Z",end:"2026-11-01T05:00:00.000Z",
  });
  assert.equal(
    moveOccurrenceByCivilMinutes(beforeFold,60,"America/New_York","earlier").start,
    "2026-11-01T05:30:00.000Z",
  );
  assert.equal(
    moveOccurrenceByCivilMinutes(beforeFold,60,"America/New_York","later").start,
    "2026-11-01T06:30:00.000Z",
  );
  const point=occurrence({start:"2026-11-10T09:00:00.000Z",end:"2026-11-10T09:00:00.000Z",temporalForm:"point"});
  assert.deepEqual(moveOccurrenceByCivilMinutes(point,15,"UTC","earlier"),{
    start:"2026-11-10T09:15:00.000Z",end:"2026-11-10T09:15:00.000Z",
  });
  const spring=occurrence({start:"2026-03-08T06:30:00.000Z",end:"2026-03-08T07:30:00.000Z"});
  assert.equal(moveOccurrenceByCivilMinutes(spring,30,"America/New_York","earlier"),null,
    "01:30 + 30 civil minutes targets the spring-forward gap and must fail closed");
});

test("resize math uses core interval constraints and refuses point resize",()=>{
  const resized=resizeOccurrenceByCivilMinutes(occurrence(),"end",-50,15,"UTC","earlier");
  assert.deepEqual(resized,{start:"2026-11-10T09:00:00.000Z",end:"2026-11-10T09:15:00.000Z"});
  const point=occurrence({start:"2026-11-10T09:00:00.000Z",end:"2026-11-10T09:00:00.000Z",temporalForm:"point"});
  assert.equal(resizeOccurrenceByCivilMinutes(point,"end",15,5,"UTC","earlier"),null);
});


test("shared resource interaction executor owns scope, warning confirmation and one atomic commit", async()=>{
  const recurring=occurrence({recurring:true});
  const resources=[
    {id:"a",title:"A",acceptsAssignments:true},
    {id:"b",title:"B",acceptsAssignments:true},
  ];
  const assignment={occurrenceId:"occ",resourceIds:["a"],version:{revision:7}};
  const commits=[];
  const requests=[];
  let confirmed=0;
  const execution=await executeCalendarResourceInteraction(
    resources,
    recurring,
    "a",
    assignment,
    "move",
    {
      start:"2026-11-10T09:30:00.000Z",
      end:"2026-11-10T10:30:00.000Z",
      targetResourceId:"b",
      toResourceIds:["b"],
    },
    "UTC",
    {
      mutationPort:{commit(change){commits.push(change);}},
      occurrenceCapabilityProvider:{capabilities(){return {canMove:true};}},
      resourceCapabilityProvider:{capabilities(){return {canReassign:true};}},
      resourceGuards:[{id:"warn",evaluate(){return {mode:"warn",message:"Check room."};}}],
      sourceForOccurrence(){return {id:"calendar",title:"Calendar",visible:true};},
      resolveScope(_occurrence,action){requests.push(action);return "this-and-following";},
      confirmWarnings(messages,request){
        confirmed+=1;
        assert.deepEqual(messages,["Check room."]);
        assert.equal(request.scope,"this-and-following");
        return true;
      },
    },
  );
  assert.equal(execution.status,"executed");
  assert.equal(execution.result.status,"committed");
  assert.equal(execution.request.action,"resource-time-move");
  assert.equal(execution.request.assignmentVersion.revision,7);
  assert.deepEqual(requests,["resource-time-move"]);
  assert.equal(confirmed,1);
  assert.equal(commits.length,1);
  assert.deepEqual(commits[0].fromResourceIds,["a"]);
  assert.deepEqual(commits[0].toResourceIds,["b"]);
});

test("shared resource interaction executor cancels recurring edits before mutation", async()=>{
  let committed=0;
  const execution=await executeCalendarResourceInteraction(
    [{id:"a",title:"A",acceptsAssignments:true}],
    occurrence({recurring:true}),
    "a",
    {occurrenceId:"occ",resourceIds:["a"]},
    "move",
    {
      start:"2026-11-10T09:15:00.000Z",
      end:"2026-11-10T10:15:00.000Z",
      targetResourceId:"a",
      toResourceIds:["a"],
    },
    "UTC",
    {
      mutationPort:{commit(){committed+=1;}},
      occurrenceCapabilityProvider:{capabilities(){return {canMove:true};}},
      sourceForOccurrence(){return {id:"calendar",title:"Calendar",visible:true};},
      resolveScope(){return null;},
    },
  );
  assert.deepEqual(execution,{status:"cancelled"});
  assert.equal(committed,0);
});
