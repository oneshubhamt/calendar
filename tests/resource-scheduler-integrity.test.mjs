import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCalendarResources, flattenCalendarResources,
  validateCalendarResourceAssignments, associateCalendarResources,
} from "../dist/features/resource-scheduler/index.js";

const resources = [
  {id:"roomB",title:"Room B",parentId:"rooms",acceptsAssignments:true,order:2},
  {id:"rooms",title:"Rooms",order:1},
  {id:"roomA",title:"Room A",parentId:"rooms",acceptsAssignments:true,order:1},
  {id:"doctor",title:"Doctor",acceptsAssignments:true,order:2},
];
const occ = id => ({occurrenceId:id});
const occurrences = [occ("z"),occ("a"),occ("unassigned")];

test("R2 validates full resource hierarchy; never accepts invalid identities, parent links or cyclic ancestry",()=>{
  assert.equal(validateCalendarResources(resources),resources);
  const bad = (variant, error) => assert.throws(()=>validateCalendarResources(variant),error);
  bad([...resources,resources[0]],/duplicate resource/i);
  bad([{id:"child",title:"Child",parentId:"missing"}],/missing parent/i);
  bad([{id:"self",title:"Self",parentId:"self"}],/parent itself/i);
  bad([{id:"a",title:"A",parentId:"b"},{id:"b",title:"B",parentId:"c"},{id:"c",title:"C",parentId:"a"}],/cycle/i);
  bad([{id:"a",title:"A",order:NaN}],/order/i);
  bad([{id:"a",title:"A",order:1.3}],/order/i);
  bad([{id:"a",title:"A",order:Infinity}],/order/i);
  bad([{id:"a",title:"A",acceptsAssignments:"true"}],/acceptsAssignments/i);
  bad([{id:"a",title:"A",display:{unknown:"x"}}],/display/i);
  bad([{id:"a",title:"A",display:{color:17}}],/display/i);
  bad([{id:"a",title:"A",metadata:{x:Infinity}}],/non-finite/i);
  const cyc={};cyc.self=cyc;
  bad([{id:"a",title:"A",metadata:cyc}],/cycle/i);
  bad([{id:"",title:"Empty"}],/id/i);
  bad([{id:"a",title:"  "}],/title/i);
});

test("R2 flattening is deterministic, respects caller-only collapse state and allows assignable parents",()=>{
  const reversed=[...resources].reverse();
  const rows=flattenCalendarResources(resources);
  assert.deepEqual(rows.map(r=>[r.resource.id,r.depth,r.index,r.acceptsAssignments,r.hasChildren]),[
    ["rooms",0,0,false,true],["roomA",1,1,true,false],
    ["roomB",1,2,true,false],["doctor",0,3,true,false],
  ]);
  assert.deepEqual(flattenCalendarResources(reversed),rows.map(r=>({...r,resource:reversed.find(x=>x.id===r.resource.id)})));
  assert.deepEqual(flattenCalendarResources(resources,["rooms"]).map(r=>r.resource.id),["rooms","doctor"]);
  assert.equal(flattenCalendarResources([{id:"g",title:"Group",acceptsAssignments:true},{id:"c",title:"Child",parentId:"g"}])[0].acceptsAssignments,true);
  assert.throws(()=>flattenCalendarResources(resources,["unknown"]),/unknown collapsed/i);
  assert.throws(()=>flattenCalendarResources(resources,["rooms","rooms"]),/duplicate collapsed/i);
  assert.deepEqual(flattenCalendarResources(resources).map(r=>r.resource.id),rows.map(r=>r.resource.id));
});

test("R2 rejects invalid assignment projections including duplicates, unknown IDs, group-only resources and opaque tokens",()=>{
  const check=(assignments,error,occs=occurrences)=>assert.throws(()=>validateCalendarResourceAssignments(resources,occs,assignments),error);
  check([{occurrenceId:"not-projected",resourceIds:["roomA"]}],/unknown occurrence/i);
  check([{occurrenceId:"a",resourceIds:["missing"]}],/unknown resource/i);
  check([{occurrenceId:"a",resourceIds:["rooms"]}],/does not accept/i);
  check([{occurrenceId:"a",resourceIds:["roomA","roomA"]}],/duplicate resource/i);
  check([{occurrenceId:"a",resourceIds:["roomA"]},{occurrenceId:"a",resourceIds:["roomB"]}],/duplicate resource assignment/i);
  check([{occurrenceId:"a",resourceIds:null}],/must be an array/i);
  check([{occurrenceId:"a",resourceIds:["roomA"],version:NaN}],/non-finite/i);
  const token={}; token.self=token;
  check([{occurrenceId:"a",resourceIds:["roomA"],version:token}],/cycle/i);
  check([],/duplicate occurrence/i,[occ("a"),occ("a")]);
  assert.deepEqual(validateCalendarResourceAssignments(resources,occurrences,[]),[]);
});

test("R2 stable multi-resource associations preserve all assignments independent of projection order",()=>{
  const assignments=[
    {occurrenceId:"z",resourceIds:["doctor","roomB","roomA"],version:{revision:7}},
    {occurrenceId:"a",resourceIds:["roomB"]},
  ];
  const normalized=validateCalendarResourceAssignments(resources,occurrences,assignments);
  assert.deepEqual(normalized.map(x=>[x.occurrenceId,x.resourceIds]),[
    ["a",["roomB"]],["z",["roomA","roomB","doctor"]],
  ]);
  const pairs=associateCalendarResources(resources,occurrences,assignments);
  assert.deepEqual(pairs.map(x=>[x.resourceId,x.occurrenceId]),[
    ["roomA","z"],["roomB","a"],["roomB","z"],["doctor","z"],
  ]);
  assert.deepEqual(associateCalendarResources([...resources].reverse(),[...occurrences].reverse(),[...assignments].reverse())
    .map(x=>[x.resourceId,x.occurrenceId]),pairs.map(x=>[x.resourceId,x.occurrenceId]));
  assert.deepEqual(pairs.find(x=>x.resourceId==="roomA").assignmentVersion,{revision:7});
  assert.equal(pairs.some(x=>x.occurrenceId==="unassigned"),false);
  assert.deepEqual(assignments[0].resourceIds,["doctor","roomB","roomA"],"must not mutate host state");
});
