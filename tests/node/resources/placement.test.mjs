import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCalendarResourcePlacement,
  executeCalendarResourcePlacement,
} from "../../../dist/features/resource-scheduler/index.js";
import { CalendarCommandStaleError } from "../../../dist/core/commands.js";
import { makeResourceOccurrence } from "../../fixtures/domain.mjs";

const resources=[
  {id:"rooms",title:"Rooms"},
  {id:"a",title:"Room A",parentId:"rooms",order:1,acceptsAssignments:true},
  {id:"b",title:"Room B",parentId:"rooms",order:2,acceptsAssignments:true},
  {id:"doctor",title:"Doctor",order:2,acceptsAssignments:true},
];
const source={id:"calendar",title:"Calendar",visible:true};
const occurrence = makeResourceOccurrence;
function request(overrides={}){
  return {
    occurrence:occurrence(),sourceResourceId:"a",targetResourceId:"b",
    fromResourceIds:["doctor","a"],toResourceIds:["doctor","b"],
    start:"2026-11-10T09:00:00.000Z",end:"2026-11-10T10:00:00.000Z",
    scope:"this",timeZone:"UTC",action:"resource-reassign",assignmentVersion:{revision:7},
    ...overrides,
  };
}
const allowReassign={capabilities(){return {canReassign:true};}};

test("validates complete target resource assignments and fails closed before policy/mutation",async()=>{
  let guardCalls=0;
  const base={resourceCapabilityProvider:allowReassign,resourceGuards:[{id:"g",evaluate(){guardCalls++;return {mode:"allow"};}}]};
  for(const [patch,pattern] of [
    [{toResourceIds:["b","b"]},/duplicate resource.*b/i],
    [{toResourceIds:["missing"]},/unknown resource.*missing/i],
    [{toResourceIds:["rooms"]},/does not accept assignments/i],
    [{sourceResourceId:"b"},/source resource b is not in the current assignment/i],
    [{targetResourceId:"a"},/target resource a is not in the target assignment/i],
  ]){
    const result=await evaluateCalendarResourcePlacement(resources,request(patch),base);
    assert.equal(result.mode,"prevent");
    assert.match(result.messages[0],pattern);
  }
  assert.equal(guardCalls,0);
});

test("composes generic temporal placement before resource guards and preserves warnings",async()=>{
  const order=[];
  const result=await evaluateCalendarResourcePlacement(resources,request(),{
    resourceCapabilityProvider:allowReassign,
    temporal:{guards:[{id:"temporal",evaluate(){order.push("temporal");return {mode:"warn",message:"Temporal preference."};}}]},
    resourceGuards:[
      {id:"r1",evaluate(){order.push("resource-1");return {mode:"allow"};}},
      {id:"r2",evaluate(ctx){order.push("resource-2");assert.deepEqual(ctx.toResourceIds,["b","doctor"]);return {mode:"warn",message:"Resource preference."};}},
    ],
  });
  assert.equal(result.mode,"warn");
  assert.deepEqual(result.messages,["Temporal preference.","Resource preference."]);
  assert.deepEqual(order,["temporal","resource-1","resource-2"]);

  const failed=await evaluateCalendarResourcePlacement(resources,request(),{
    resourceCapabilityProvider:allowReassign,
    resourceGuards:[{id:"x",evaluate:()=>({mode:"allow"})},{id:"x",evaluate:()=>({mode:"allow"})}],
  });
  assert.equal(failed.mode,"prevent");
  assert.deepEqual(failed.messages,["Resource scheduling policy could not be evaluated."]);
});

test("resource collisions are scoped to shared target resources and reuse temporal overlap semantics",async()=>{
  const occupiedA=occurrence({occurrenceId:"a-occ",sourceItemId:"a-item",title:"Occupied A",start:"2026-11-10T09:30:00.000Z",end:"2026-11-10T10:30:00.000Z"});
  const occupiedB=occurrence({occurrenceId:"b-occ",sourceItemId:"b-item",title:"Occupied B",start:"2026-11-10T09:30:00.000Z",end:"2026-11-10T10:30:00.000Z"});
  const outside=occurrence({occurrenceId:"outside",sourceItemId:"outside",title:"Later B",start:"2026-11-10T12:00:00.000Z",end:"2026-11-10T13:00:00.000Z"});
  let loads=0;
  const result=await evaluateCalendarResourcePlacement(resources,request(),{
    resourceCapabilityProvider:allowReassign,
    resourceCollisionPolicy:{mode:"warn"},
    loadResourceCollisionProjection(){
      loads++;
      return {
        occurrences:[occupiedA,occupiedB,outside],
        assignments:[
          {occurrenceId:"a-occ",resourceIds:["a"]},
          {occurrenceId:"b-occ",resourceIds:["b","doctor"]},
          {occurrenceId:"outside",resourceIds:["b"]},
        ],
      };
    },
  });
  assert.equal(loads,1);
  assert.equal(result.mode,"warn");
  assert.deepEqual(result.resourceCollisions.map(row=>[row.occurrence.title,row.resourceIds]),[
    ["Occupied B",["b","doctor"]],
  ]);
  assert.match(result.messages[0],/Occupied B/);
  assert.doesNotMatch(result.messages[0],/Occupied A/);

  let lazyLoads=0;
  const allowed=await evaluateCalendarResourcePlacement(resources,request(),{
    resourceCapabilityProvider:allowReassign,
    resourceCollisionPolicy:{mode:"allow"},
    loadResourceCollisionProjection(){lazyLoads++;throw new Error("must stay lazy");},
  });
  assert.equal(allowed.mode,"allow");
  assert.equal(lazyLoads,0);
});

test("temporal and resource authorities are independent and required only for changed dimensions",async()=>{
  const trustedMove={capabilities(){return {commandPath:"trusted-host",canMove:true};}};
  let resourceCalls=0;
  const resourceProvider={capabilities(){resourceCalls++;return {canReassign:true};}};

  const timeOnly=await evaluateCalendarResourcePlacement(resources,request({
    sourceResourceId:"a",targetResourceId:"a",fromResourceIds:["a"],toResourceIds:["a"],
    start:"2026-11-10T11:00:00.000Z",end:"2026-11-10T12:00:00.000Z",
  }),{
    source:{...source,readOnly:true},
    occurrenceCapabilityProvider:trustedMove,
    resourceCapabilityProvider:{capabilities(){throw new Error("resource authority must not be read");}},
  });
  assert.equal(timeOnly.mode,"allow");
  assert.deepEqual(timeOnly.requiredTemporalCapabilities,["canMove"]);
  assert.equal(timeOnly.requiresResourceReassignment,false);

  const resourceOnly=await evaluateCalendarResourcePlacement(resources,request(),{
    source:{...source,readOnly:true},
    occurrenceCapabilityProvider:{capabilities(){throw new Error("temporal authority must not be read");}},
    resourceCapabilityProvider:resourceProvider,
  });
  assert.equal(resourceOnly.mode,"allow");
  assert.deepEqual(resourceOnly.requiredTemporalCapabilities,[]);
  assert.equal(resourceOnly.requiresResourceReassignment,true);
  assert.equal(resourceCalls,1);

  const diagonal=await evaluateCalendarResourcePlacement(resources,request({
    start:"2026-11-10T11:00:00.000Z",end:"2026-11-10T12:00:00.000Z",
  }),{
    source:{...source,readOnly:true},
    occurrenceCapabilityProvider:trustedMove,
    resourceCapabilityProvider:resourceProvider,
  });
  assert.equal(diagonal.mode,"allow");
  assert.deepEqual(diagonal.requiredTemporalCapabilities,["canMove"]);
  assert.equal(diagonal.requiresResourceReassignment,true);

  const deniedTemporal=await evaluateCalendarResourcePlacement(resources,request({
    start:"2026-11-10T11:00:00.000Z",end:"2026-11-10T12:00:00.000Z",
  }),{source:{...source,readOnly:true},resourceCapabilityProvider:allowReassign});
  assert.equal(deniedTemporal.mode,"prevent");
  assert.match(deniedTemporal.messages[0],/temporal placement is not authorized/i);

  const deniedResource=await evaluateCalendarResourcePlacement(resources,request(),{
    source,resourceCapabilityProvider:{capabilities(){return {canReassign:false};}},
  });
  assert.equal(deniedResource.mode,"prevent");
  assert.match(deniedResource.messages[0],/resource reassignment is not authorized/i);
});

test("execution commits exactly once with canonical full assignments and never splits diagonal mutation",async()=>{
  const changes=[];
  const result=await executeCalendarResourcePlacement(resources,request({
    start:"2026-11-10T11:00:00+00:00",end:"2026-11-10T12:00:00+00:00",
  }),{
    source,
    resourceCapabilityProvider:allowReassign,
    mutationPort:{commit(change){changes.push(change);}},
  });
  assert.equal(result.status,"committed");
  assert.equal(changes.length,1);
  assert.deepEqual(changes[0].fromResourceIds,["a","doctor"]);
  assert.deepEqual(changes[0].toResourceIds,["b","doctor"]);
  assert.equal(changes[0].start,"2026-11-10T11:00:00.000Z");
  assert.equal(changes[0].end,"2026-11-10T12:00:00.000Z");
  assert.equal(changes[0].scope,"this");
  assert.deepEqual(changes[0].assignmentVersion,{revision:7});
});

test("warnings require explicit acceptance; no-ops and prevented placements never write",async()=>{
  let commits=0;
  const mutationPort={commit(){commits++;}};
  const warningOptions={
    source,resourceCapabilityProvider:allowReassign,mutationPort,
    resourceGuards:[{id:"warn",evaluate:()=>({mode:"warn",message:"Check resource."})}],
  };
  const warning=await executeCalendarResourcePlacement(resources,request(),warningOptions);
  assert.equal(warning.status,"warning");
  assert.equal(commits,0);
  const accepted=await executeCalendarResourcePlacement(resources,request(),{...warningOptions,acceptWarnings:true});
  assert.equal(accepted.status,"committed");
  assert.equal(commits,1);

  const noop=await executeCalendarResourcePlacement(resources,request({
    sourceResourceId:"a",targetResourceId:"a",fromResourceIds:["a"],toResourceIds:["a"],
    assignmentVersion:undefined,
  }),{source,mutationPort,resourceCapabilityProvider:{capabilities(){throw new Error("unused");}}});
  assert.equal(noop.status,"noop");
  assert.equal(commits,1);

  const prevented=await executeCalendarResourcePlacement(resources,request(),{
    source,resourceCapabilityProvider:{capabilities(){return {canReassign:false};}},mutationPort,
  });
  assert.equal(prevented.status,"prevented");
  assert.equal(commits,1);
});

test("stale assignment versions return stale after one atomic attempt and are never retried",async()=>{
  let commits=0;
  let seen;
  const result=await executeCalendarResourcePlacement(resources,request(),{
    source,resourceCapabilityProvider:allowReassign,
    mutationPort:{commit(change){commits++;seen=change;throw new CalendarCommandStaleError("assignment revision changed");}},
  });
  assert.equal(result.status,"stale");
  assert.equal(commits,1);
  assert.deepEqual(seen.assignmentVersion,{revision:7});
  assert.equal(result.error.code,"stale");

  const structural=await executeCalendarResourcePlacement(resources,request(),{
    source,resourceCapabilityProvider:allowReassign,
    mutationPort:{commit(){throw Object.assign(new Error("stale cross-realm"),{code:"stale"});}},
  });
  assert.equal(structural.status,"stale");
});

test("malformed resource collision policy/projections fail closed instead of weakening resource safety",async()=>{
  const malformedPolicy=await evaluateCalendarResourcePlacement(resources,request(),{
    resourceCapabilityProvider:allowReassign,
    resourceCollisionPolicy:{mode:"maybe"},
    loadResourceCollisionProjection:()=>({occurrences:[],assignments:[]}),
  });
  assert.equal(malformedPolicy.mode,"prevent");
  assert.deepEqual(malformedPolicy.messages,["Resource conflicts could not be evaluated."]);

  const badProjection=await evaluateCalendarResourcePlacement(resources,request(),{
    resourceCapabilityProvider:allowReassign,
    resourceCollisionPolicy:{mode:"prevent"},
    loadResourceCollisionProjection:()=>({
      occurrences:[occurrence({occurrenceId:"bad",start:"not-a-time",end:"also-bad"})],
      assignments:[{occurrenceId:"bad",resourceIds:["b"]}],
    }),
  });
  assert.equal(badProjection.mode,"prevent");
  assert.deepEqual(badProjection.messages,["Resource conflicts could not be evaluated."]);
});


test("unassigned recurring occurrences preserve every requested recurrence scope in one atomic assignment",async()=>{
  const row=occurrence({
    occurrenceId:"unassigned",sourceItemId:"unassigned-item",recurring:true,
    projectionIdentity:{series:"s",slot:4},
  });
  for(const scope of ["this","this-and-following","all"]){
    const commits=[];
    const result=await executeCalendarResourcePlacement(resources,{
      occurrence:row,targetResourceId:"a",fromResourceIds:[],toResourceIds:["a"],
      start:row.start,end:row.end,scope,timeZone:"UTC",action:"resource-reassign",
      assignmentVersion:{revision:11},
    },{
      source,
      resourceCapabilityProvider:allowReassign,
      mutationPort:{commit(change){commits.push(change);}},
    });
    assert.equal(result.status,"committed");
    assert.equal(commits.length,1);
    assert.equal(commits[0].scope,scope);
    assert.deepEqual(commits[0].fromResourceIds,[]);
    assert.deepEqual(commits[0].toResourceIds,["a"]);
    assert.deepEqual(commits[0].assignmentVersion,{revision:11});
    assert.strictEqual(commits[0].occurrence,row);
  }
});

test("resource placement preserves opaque occurrence identity through one diagonal host mutation",async()=>{
  const row=occurrence({
    occurrenceId:"projected",
    sourceItemId:"projected-item",
    recurring:true,
    editPolicy:"readonly",
    projectionIdentity:{series:{opaque:"host-series"},slot:["x",4]},
  });
  const changes=[];
  const result=await executeCalendarResourcePlacement(resources,request({
    occurrence:row,
    start:"2026-11-10T12:00:00.000Z",
    end:"2026-11-10T13:00:00.000Z",
    scope:"this-and-following",
    action:"resource-time-move",
  }),{
    source:{...source,readOnly:true},
    occurrenceCapabilityProvider:{capabilities(){return {commandPath:"trusted-host",canMove:true};}},
    resourceCapabilityProvider:allowReassign,
    mutationPort:{commit(change){changes.push(change);}},
  });
  assert.equal(result.status,"committed");
  assert.equal(changes.length,1);
  assert.strictEqual(changes[0].occurrence,row);
  assert.deepEqual(changes[0].occurrence.projectionIdentity,row.projectionIdentity);
  assert.equal(changes[0].scope,"this-and-following");
});

test("resource placement rejects malformed time zones and mismatched source authority",async()=>{
  const invalidZone=await evaluateCalendarResourcePlacement(resources,request({timeZone:"Not/A_Real_Zone"}),{
    source,
    resourceCapabilityProvider:allowReassign,
  });
  assert.equal(invalidZone.mode,"prevent");
  assert.match(invalidZone.messages[0],/time zone/i);

  const wrongSource=await evaluateCalendarResourcePlacement(resources,request({
    sourceResourceId:"a",targetResourceId:"a",fromResourceIds:["a"],toResourceIds:["a"],
    start:"2026-11-10T11:00:00.000Z",end:"2026-11-10T12:00:00.000Z",action:"move",
  }),{
    source:{id:"other",title:"Wrong source",visible:true},
    occurrenceCapabilityProvider:{capabilities(){return {commandPath:"trusted-host",canMove:true};}},
  });
  assert.equal(wrongSource.mode,"prevent");
  assert.match(wrongSource.messages[0],/source does not match/i);
});

test("non-stale atomic mutation failures are attempted once and propagate unchanged",async()=>{
  let commits=0;
  await assert.rejects(
    ()=>executeCalendarResourcePlacement(resources,request(),{
      source,
      resourceCapabilityProvider:allowReassign,
      mutationPort:{async commit(){commits++;throw new Error("atomic host failure");}},
    }),
    /atomic host failure/,
  );
  assert.equal(commits,1);
});
