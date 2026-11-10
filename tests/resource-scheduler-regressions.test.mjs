import test from "node:test";
import assert from "node:assert/strict";
import * as Calendar from "../dist/index.js";
import {
  associateCalendarResources,
  evaluateCalendarResourcePlacement,
  executeCalendarResourcePlacement,
  flattenCalendarResources,
  layoutResourceTimeline,
  replaceCalendarResourceAssignment,
  validateCalendarResourceAssignments,
} from "../dist/features/resource-scheduler/index.js";
import {
  moveResourceOccurrenceByCivilMinutes,
} from "../dist/features/resource-scheduler-ui/interaction.js";
import { CalendarStaleError } from "../dist/core/revision.js";

const resources=[
  {id:"rooms",title:"Rooms",order:1},
  {id:"room-a",title:"Room A",parentId:"rooms",order:1,acceptsAssignments:true},
  {id:"room-b",title:"Room B",parentId:"rooms",order:2,acceptsAssignments:true},
  {id:"doctor",title:"Doctor",order:2,acceptsAssignments:true},
];
const source={id:"host",title:"Host",visible:true,readOnly:true};

function occurrence(id="occ",overrides={}){
  return {
    occurrenceId:id,sourceItemId:`item-${id}`,calendarId:"host",title:`Event ${id}`,
    start:"2026-11-10T09:00:00.000Z",end:"2026-11-10T10:00:00.000Z",
    originalStart:"2026-11-10T09:00:00.000Z",recurring:false,
    kind:"host-event",ownership:"host",editPolicy:"readonly",...overrides,
  };
}
function placementRequest(row,overrides={}){
  return {
    occurrence:row,
    sourceResourceId:"room-a",targetResourceId:"room-b",
    fromResourceIds:["doctor","room-a"],toResourceIds:["doctor","room-b"],
    start:row.start,end:row.end,scope:"this",timeZone:"UTC",
    action:"resource-reassign",assignmentVersion:{revision:7},...overrides,
  };
}
const resourceAuthority={capabilities(){return {canReassign:true};}};
const trustedTemporal={capabilities(){return {commandPath:"trusted-host",canMove:true,canResizeStart:true,canResizeEnd:true};}};

async function filesUnder(root){
  const out=[];
  for(const entry of await fs.readdir(root,{withFileTypes:true})){
    const full=new URL(entry.name+(entry.isDirectory()?"/":""),root);
    if(entry.isDirectory()) out.push(...await filesUnder(full));
    else if(entry.isFile() && /\.(?:ts|tsx|js|mjs)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

test("Resource Scheduler hierarchy, collapse, multi-resource and unassigned semantics compose deterministically",()=>{
  const rows=flattenCalendarResources([...resources].reverse());
  assert.deepEqual(rows.map(row=>[row.resource.id,row.depth,row.acceptsAssignments]),[
    ["rooms",0,false],["room-a",1,true],["room-b",1,true],["doctor",0,true],
  ]);
  assert.deepEqual(flattenCalendarResources(resources,["rooms"]).map(row=>row.resource.id),["rooms","doctor"]);

  const assigned=occurrence("assigned");
  const unassigned=occurrence("unassigned");
  const assignments=[{occurrenceId:"assigned",resourceIds:["doctor","room-b","room-a"],version:{revision:2}}];
  assert.deepEqual(validateCalendarResourceAssignments(resources,[unassigned,assigned],assignments)[0].resourceIds,[
    "room-a","room-b","doctor",
  ]);
  assert.deepEqual(associateCalendarResources(resources,[assigned,unassigned],assignments).map(row=>row.resourceId),[
    "room-a","room-b","doctor",
  ]);
  assert.equal(associateCalendarResources(resources,[assigned,unassigned],assignments).some(row=>row.occurrenceId==="unassigned"),false);

  const layout=layoutResourceTimeline(resources,[unassigned,assigned],assignments,{
    start:"2026-11-10T08:00:00.000Z",end:"2026-11-10T11:00:00.000Z",
  },{timeZone:"UTC"});
  assert.equal(layout.length,3);
  assert.equal(layout.some(row=>row.occurrenceId==="unassigned"),false);
  assert.equal(new Set(layout.map(row=>row.renderId)).size,3);
  assert.deepEqual(replaceCalendarResourceAssignment(["room-a","doctor"],"room-a","room-b"),["room-b","doctor"]);
});

test("Resource Scheduler unassigned host occurrences can be assigned headlessly and every recurrence scope survives the one atomic change",async()=>{
  const row=occurrence("recurring-unassigned",{recurring:true,projectionIdentity:{series:"s",slot:4}});
  for(const scope of ["this","this-and-following","all"]){
    const commits=[];
    const result=await executeCalendarResourcePlacement(resources,{
      occurrence:row,targetResourceId:"room-a",fromResourceIds:[],toResourceIds:["room-a"],
      start:row.start,end:row.end,scope,timeZone:"UTC",action:"resource-reassign",
      assignmentVersion:{revision:11},
    },{
      source,resourceCapabilityProvider:resourceAuthority,
      mutationPort:{commit(change){commits.push(change);}},
    });
    assert.equal(result.status,"committed");
    assert.equal(commits.length,1);
    assert.equal(commits[0].scope,scope);
    assert.deepEqual(commits[0].fromResourceIds,[]);
    assert.deepEqual(commits[0].toResourceIds,["room-a"]);
    assert.deepEqual(commits[0].assignmentVersion,{revision:11});
    assert.strictEqual(commits[0].occurrence,row);
  }
});

test("Resource Scheduler trusted host occurrence projection stays opaque while temporal and resource authority remain independent",async()=>{
  const projected={
    ...occurrence("projected",{
      recurring:true,
      projectionIdentity:{series:{opaque:"host-series"},slot:["x",4]},
      start:"2026-11-10T10:00:00.000Z",end:"2026-11-10T11:00:00.000Z",
      originalStart:"2026-11-10T09:00:00.000Z",
    }),
  };
  const repo=new Calendar.MemoryCalendarRepository([source],[]);
  const engine=new Calendar.CalendarEngine(repo,[],[{
    id:"host-occurrence",
    projectOccurrences(){return [projected];},
  }]);
  const queried=await engine.query({start:"2026-11-10T00:00:00.000Z",end:"2026-11-11T00:00:00.000Z"});
  const row=queried.occurrences[0];
  assert.deepEqual(row.projectionIdentity,projected.projectionIdentity);
  assert.equal(row.recurring,true);

  const resourceOnly=await evaluateCalendarResourcePlacement(resources,placementRequest(row),{
    source,
    occurrenceCapabilityProvider:{capabilities(){throw new Error("temporal provider must not run");}},
    resourceCapabilityProvider:resourceAuthority,
  });
  assert.equal(resourceOnly.mode,"allow");
  assert.deepEqual(resourceOnly.requiredTemporalCapabilities,[]);
  assert.equal(resourceOnly.requiresResourceReassignment,true);

  const changes=[];
  const diagonal=await executeCalendarResourcePlacement(resources,placementRequest(row,{
    start:"2026-11-10T12:00:00.000Z",end:"2026-11-10T13:00:00.000Z",
    action:"resource-time-move",scope:"this-and-following",
  }),{
    source,
    occurrenceCapabilityProvider:trustedTemporal,
    resourceCapabilityProvider:resourceAuthority,
    mutationPort:{commit(change){changes.push(change);}},
  });
  assert.equal(diagonal.status,"committed");
  assert.equal(changes.length,1);
  assert.strictEqual(changes[0].occurrence,row);
  assert.deepEqual(changes[0].occurrence.projectionIdentity,projected.projectionIdentity);
  assert.equal(changes[0].scope,"this-and-following");
});

test("Resource Scheduler resource collision policy is target-scoped and malformed timezone/source authority fails closed",async()=>{
  const row=occurrence();
  const occupiedA=occurrence("occupied-a",{title:"A conflict",start:"2026-11-10T09:30:00.000Z",end:"2026-11-10T10:30:00.000Z"});
  const occupiedB=occurrence("occupied-b",{title:"B conflict",start:"2026-11-10T09:30:00.000Z",end:"2026-11-10T10:30:00.000Z"});
  const collision=await evaluateCalendarResourcePlacement(resources,placementRequest(row),{
    source,resourceCapabilityProvider:resourceAuthority,
    resourceCollisionPolicy:{mode:"warn"},
    loadResourceCollisionProjection:()=>({
      occurrences:[occupiedA,occupiedB],
      assignments:[
        {occurrenceId:"occupied-a",resourceIds:["room-a"]},
        {occurrenceId:"occupied-b",resourceIds:["room-b"]},
      ],
    }),
  });
  assert.equal(collision.mode,"warn");
  assert.deepEqual(collision.resourceCollisions.map(entry=>entry.occurrence.occurrenceId),["occupied-b"]);

  const invalidZone=await evaluateCalendarResourcePlacement(resources,placementRequest(row,{timeZone:"Not/A_Real_Zone"}),{
    source,resourceCapabilityProvider:resourceAuthority,
  });
  assert.equal(invalidZone.mode,"prevent");
  assert.match(invalidZone.messages[0],/time zone/i);

  const wrongSource=await evaluateCalendarResourcePlacement(resources,placementRequest(row,{
    start:"2026-11-10T11:00:00.000Z",end:"2026-11-10T12:00:00.000Z",action:"move",
    sourceResourceId:"room-a",targetResourceId:"room-a",fromResourceIds:["room-a"],toResourceIds:["room-a"],
  }),{
    source:{id:"other",title:"Wrong source",visible:true},
    occurrenceCapabilityProvider:trustedTemporal,
  });
  assert.equal(wrongSource.mode,"prevent");
  assert.match(wrongSource.messages[0],/source does not match/i);
});

test("Resource Scheduler DST, cross-midnight and point interaction semantics preserve canonical civil behavior",()=>{
  const overnight=occurrence("overnight",{
    calendarId:"host",editPolicy:"full",
    start:"2026-11-10T23:30:00.000Z",end:"2026-11-11T00:30:00.000Z",
  });
  assert.deepEqual(moveResourceOccurrenceByCivilMinutes(overnight,60,"UTC","earlier"),{
    start:"2026-11-11T00:30:00.000Z",end:"2026-11-11T01:30:00.000Z",
  });

  const beforeFold=occurrence("fold",{
    start:"2026-11-01T04:30:00.000Z",end:"2026-11-01T05:00:00.000Z",
  });
  assert.equal(moveResourceOccurrenceByCivilMinutes(beforeFold,60,"America/New_York","earlier").start,"2026-11-01T05:30:00.000Z");
  assert.equal(moveResourceOccurrenceByCivilMinutes(beforeFold,60,"America/New_York","later").start,"2026-11-01T06:30:00.000Z");

  const spring=occurrence("spring",{
    start:"2026-03-08T06:30:00.000Z",end:"2026-03-08T07:30:00.000Z",
  });
  assert.equal(moveResourceOccurrenceByCivilMinutes(spring,30,"America/New_York","earlier"),null);

  const point=occurrence("point",{
    start:"2026-11-10T10:00:00.000Z",end:"2026-11-10T10:00:00.000Z",temporalForm:"point",
  });
  const movedPoint=moveResourceOccurrenceByCivilMinutes(point,15,"UTC","earlier");
  assert.equal(movedPoint.start,movedPoint.end);
  const pointLayout=layoutResourceTimeline(resources,[point],[{occurrenceId:"point",resourceIds:["room-a"]}],{
    start:"2026-11-10T09:00:00.000Z",end:"2026-11-10T11:00:00.000Z",
  },{timeZone:"UTC"});
  assert.equal(pointLayout[0].widthMinutes,0);
});

test("Resource Scheduler stale and failed atomic writes are single-attempt and never mutate scheduler-owned projection state",async()=>{
  const row=occurrence();
  let staleCalls=0;
  const stale=await executeCalendarResourcePlacement(resources,placementRequest(row),{
    source,resourceCapabilityProvider:resourceAuthority,
    mutationPort:{commit(){staleCalls++;throw new CalendarStaleError("changed elsewhere");}},
  });
  assert.equal(stale.status,"stale");
  assert.equal(staleCalls,1);

  let failedCalls=0;
  await assert.rejects(()=>executeCalendarResourcePlacement(resources,placementRequest(row),{
    source,resourceCapabilityProvider:resourceAuthority,
    mutationPort:{async commit(){failedCalls++;throw new Error("atomic host failure");}},
  }),/atomic host failure/);
  assert.equal(failedCalls,1);

  let warningCalls=0;
  const warning=await executeCalendarResourcePlacement(resources,placementRequest(row),{
    source,resourceCapabilityProvider:resourceAuthority,
    resourceGuards:[{id:"warn",evaluate:()=>({mode:"warn",message:"Confirm."})}],
    mutationPort:{commit(){warningCalls++;}},
  });
  assert.equal(warning.status,"warning");
  assert.equal(warningCalls,0);
});
