import test from "node:test";
import assert from "node:assert/strict";
import { permutations } from "../../fixtures/combinatorics.mjs";
import { makeResourceOccurrence } from "../../fixtures/domain.mjs";
import {
  validateCalendarResources, flattenCalendarResources,
  validateCalendarResourceAssignments, associateCalendarResources,
} from "../../../dist/features/resource-scheduler/index.js";

const resources = [
  {id:"roomB",title:"Room B",parentId:"rooms",acceptsAssignments:true,order:2},
  {id:"rooms",title:"Rooms",order:1},
  {id:"roomA",title:"Room A",parentId:"rooms",acceptsAssignments:true,order:1},
  {id:"doctor",title:"Doctor",acceptsAssignments:true,order:2},
];
const occ = id => ({occurrenceId:id});
const occurrences = [occ("z"),occ("a"),occ("unassigned")];

test("validates full resource hierarchy; never accepts invalid identities, parent links or cyclic ancestry",()=>{
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

test("flattening is deterministic, respects caller-only collapse state and allows assignable parents",()=>{
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

test("rejects invalid assignment projections including duplicates, unknown IDs, group-only resources and opaque tokens",()=>{
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

test("flattening remains stack-safe and deterministic for a very deep valid hierarchy",()=>{
  const depth=12000;
  const deep=Array.from({length:depth},(_,index)=>({
    id:`r${index}`,title:`Resource ${index}`,
    ...(index===0?{}:{parentId:`r${index-1}`}),
    ...(index===depth-1?{acceptsAssignments:true}:{}),
  }));
  const rows=flattenCalendarResources(deep);
  assert.equal(rows.length,depth);
  assert.equal(rows[0].depth,0);
  assert.equal(rows.at(-1).depth,depth-1);
  assert.equal(rows.at(-1).resource.id,`r${depth-1}`);
  const normalized=validateCalendarResourceAssignments(deep,[occ("deep")],[
    {occurrenceId:"deep",resourceIds:[`r${depth-1}`]},
  ]);
  assert.deepEqual(normalized[0].resourceIds,[`r${depth-1}`]);
});

test("resource assignment normalization is invariant under every small-input permutation", () => {
  const resources = [
    { id: "group", title: "Rooms" },
    { id: "a", title: "A", parentId: "group", order: 2, acceptsAssignments: true },
    { id: "b", title: "B", parentId: "group", order: 1, acceptsAssignments: true },
    { id: "c", title: "C", parentId: "group", order: 3, acceptsAssignments: true },
  ];
  const occurrences = [
    makeResourceOccurrence({ occurrenceId: "x", sourceItemId: "x", title: "X" }),
    makeResourceOccurrence({ occurrenceId: "y", sourceItemId: "y", title: "Y" }),
  ];
  const expectedAssignments = [
    { occurrenceId: "x", resourceIds: ["b", "a", "c"], version: { revision: 7 } },
    { occurrenceId: "y", resourceIds: ["b", "a"] },
  ];
  const expectedAssociations = [["b", "x", 7], ["b", "y", null], ["a", "x", 7], ["a", "y", null], ["c", "x", 7]];

  for (const resourceOrder of permutations(resources)) {
    for (const occurrenceOrder of permutations(occurrences)) {
      for (const xIds of permutations(["a", "b", "c"])) {
        for (const yIds of permutations(["a", "b"])) {
          for (const assignmentOrder of permutations([
            { occurrenceId: "x", resourceIds: xIds, version: { revision: 7 } },
            { occurrenceId: "y", resourceIds: yIds },
          ])) {
            const beforeX = xIds.slice();
            const beforeY = yIds.slice();
            assert.deepEqual(
              validateCalendarResourceAssignments(resourceOrder, occurrenceOrder, assignmentOrder),
              expectedAssignments,
            );
            assert.deepEqual(
              associateCalendarResources(resourceOrder, occurrenceOrder, assignmentOrder)
                .map(row => [row.resourceId, row.occurrenceId, row.assignmentVersion?.revision ?? null]),
              expectedAssociations,
            );
            assert.deepEqual(xIds, beforeX);
            assert.deepEqual(yIds, beforeY);
          }
        }
      }
    }
  }
});
