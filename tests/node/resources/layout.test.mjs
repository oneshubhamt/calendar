import test from "node:test";
import assert from "node:assert/strict";
import { layoutResourceTimeline } from "../../../dist/features/resource-scheduler/index.js";

const resources=[
  {id:"rooms",title:"Rooms"},
  {id:"room-a",title:"Room A",parentId:"rooms",order:1,acceptsAssignments:true},
  {id:"room-b",title:"Room B",parentId:"rooms",order:2,acceptsAssignments:true},
];
function occurrence(id,start,end=start,extra={}){
  return {
    occurrenceId:id,sourceItemId:`item-${id}`,calendarId:"calendar",title:id,
    start,end,originalStart:start,recurring:false,kind:"event",ownership:"host",
    editPolicy:"readonly",...(start===end?{temporalForm:"point"}:{}),...extra,
  };
}

test("creates deterministic horizontal geometry and independent multi-resource render identities",()=>{
  const occurrences=[
    occurrence("a","2026-11-10T09:00:00.000Z","2026-11-10T11:00:00.000Z"),
    occurrence("b","2026-11-10T10:00:00.000Z","2026-11-10T12:00:00.000Z"),
  ];
  const assignments=[
    {occurrenceId:"b",resourceIds:["room-b","room-a"]},
    {occurrenceId:"a",resourceIds:["room-a"]},
  ];
  const range={start:"2026-11-10T08:00:00.000Z",end:"2026-11-10T13:00:00.000Z"};
  const layout=layoutResourceTimeline(resources,occurrences,assignments,range,{timeZone:"UTC"});
  assert.deepEqual(layout.map(row=>[row.resourceId,row.occurrenceId,row.resourceRow,row.xMinutes,row.widthMinutes,row.lane,row.laneCount]),[
    ["room-a","a",1,60,120,0,2],
    ["room-a","b",1,120,120,1,2],
    ["room-b","b",2,120,120,0,1],
  ]);
  assert.equal(new Set(layout.map(row=>row.renderId)).size,3);
  assert.deepEqual(
    layoutResourceTimeline([...resources].reverse(),[...occurrences].reverse(),[...assignments].reverse(),range,{timeZone:"UTC"})
      .map(row=>[row.resourceId,row.occurrenceId,row.xMinutes,row.widthMinutes,row.lane,row.laneCount]),
    layout.map(row=>[row.resourceId,row.occurrenceId,row.xMinutes,row.widthMinutes,row.lane,row.laneCount]),
  );
});

test("clips cross-midnight intervals to the requested range without changing authoritative occurrence time",()=>{
  const event=occurrence("overnight","2026-11-09T23:00:00.000Z","2026-11-10T02:00:00.000Z");
  const [row]=layoutResourceTimeline(resources,[event],[{occurrenceId:"overnight",resourceIds:["room-a"]}],{
    start:"2026-11-10T00:00:00.000Z",end:"2026-11-10T03:00:00.000Z",
  },{timeZone:"UTC"});
  assert.equal(row.xMinutes,0);
  assert.equal(row.widthMinutes,120);
  assert.equal(row.occurrence.start,"2026-11-09T23:00:00.000Z");
  assert.equal(row.occurrence.end,"2026-11-10T02:00:00.000Z");
});

test("uses the same civil wall-clock DST basis as ordinary timed layout",()=>{
  const spring=occurrence("spring","2026-03-08T06:30:00.000Z","2026-03-08T07:30:00.000Z");
  const [springRow]=layoutResourceTimeline(resources,[spring],[{occurrenceId:"spring",resourceIds:["room-a"]}],{
    start:"2026-03-08T05:00:00.000Z",end:"2026-03-09T04:00:00.000Z",
  },{timeZone:"America/New_York"});
  assert.equal(springRow.xMinutes,90);
  assert.equal(springRow.widthMinutes,120,"01:30 to 03:30 spans 120 civil minutes across the spring gap");

  const earlier=occurrence("earlier","2026-11-01T05:30:00.000Z");
  const later=occurrence("later","2026-11-01T06:30:00.000Z");
  const fall=layoutResourceTimeline(resources,[later,earlier],[
    {occurrenceId:"later",resourceIds:["room-a"]},{occurrenceId:"earlier",resourceIds:["room-a"]},
  ],{start:"2026-11-01T04:00:00.000Z",end:"2026-11-02T05:00:00.000Z"},{timeZone:"America/New_York"});
  assert.deepEqual(fall.map(row=>[row.occurrenceId,row.xMinutes,row.widthMinutes,row.lane,row.laneCount]),[
    ["earlier",90,0,0,2],["later",90,0,1,2],
  ]);
});

test("point occurrences remain zero-width and interval lanes are resource-scoped presentation only",()=>{
  const pointA=occurrence("p1","2026-11-10T10:00:00.000Z");
  const pointB=occurrence("p2","2026-11-10T10:00:00.000Z");
  const block=occurrence("block","2026-11-10T09:30:00.000Z","2026-11-10T10:30:00.000Z");
  const layout=layoutResourceTimeline(resources,[pointA,pointB,block],[
    {occurrenceId:"p1",resourceIds:["room-a"]},
    {occurrenceId:"p2",resourceIds:["room-a"]},
    {occurrenceId:"block",resourceIds:["room-a","room-b"]},
  ],{start:"2026-11-10T09:00:00.000Z",end:"2026-11-10T11:00:00.000Z"},{timeZone:"UTC"});
  const roomA=layout.filter(row=>row.resourceId==="room-a");
  assert.equal(roomA.find(row=>row.occurrenceId==="p1").widthMinutes,0);
  assert.equal(roomA.find(row=>row.occurrenceId==="p2").widthMinutes,0);
  assert.equal(new Set(roomA.map(row=>row.lane)).size,3);
  const roomB=layout.find(row=>row.resourceId==="room-b");
  assert.equal(roomB.lane,0);
  assert.equal(roomB.laneCount,1);
});

test("collapse affects visible rows only; assignments remain host-authoritative",()=>{
  const event=occurrence("hidden","2026-11-10T10:00:00.000Z","2026-11-10T11:00:00.000Z");
  const assignments=[{occurrenceId:"hidden",resourceIds:["room-a"]}];
  const range={start:"2026-11-10T09:00:00.000Z",end:"2026-11-10T12:00:00.000Z"};
  assert.equal(layoutResourceTimeline(resources,[event],assignments,range,{collapsedResourceIds:["rooms"]}).length,0);
  assert.deepEqual(assignments,[{occurrenceId:"hidden",resourceIds:["room-a"]}]);
});

test("keeps folded fall-back geometry bounded when the requested range begins inside an overlap",()=>{
  const interval=occurrence("folded","2026-11-01T06:00:00.000Z","2026-11-01T07:00:00.000Z");
  const point=occurrence("folded-point","2026-11-01T06:30:00.000Z");
  const range={start:"2026-11-01T05:45:00.000Z",end:"2026-11-01T07:00:00.000Z"};
  const layout=layoutResourceTimeline(resources,[interval,point],[
    {occurrenceId:"folded",resourceIds:["room-a"]},
    {occurrenceId:"folded-point",resourceIds:["room-b"]},
  ],range,{timeZone:"America/New_York"});
  const block=layout.find(row=>row.occurrenceId==="folded");
  const marker=layout.find(row=>row.occurrenceId==="folded-point");
  assert.equal(block.xMinutes,0);
  assert.equal(block.widthMinutes,15);
  assert.ok(block.xMinutes+block.widthMinutes<=15);
  assert.equal(marker.xMinutes,0);
  assert.equal(marker.widthMinutes,0);
});
