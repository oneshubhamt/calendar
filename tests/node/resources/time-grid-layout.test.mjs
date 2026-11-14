import test from "node:test";
import assert from "node:assert/strict";
import { layoutTimedDay } from "../../../dist/index.js";
import { layoutResourceTimeGrid } from "../../../dist/features/resource-time-grid/index.js";

const resources = [
  { id: "group", title: "Rooms" },
  { id: "a", title: "Room A", parentId: "group", order: 1, acceptsAssignments: true },
  { id: "b", title: "Room B", parentId: "group", order: 2, acceptsAssignments: true },
];

function occurrence(id,start,end,extra={}) {
  return {
    occurrenceId:id,sourceItemId:id,calendarId:"calendar",title:id,
    start,end,originalStart:start,recurring:false,kind:"event",ownership:"host",editPolicy:"full",...extra,
  };
}

test("Resource TimeGrid derives deterministic day x assignable-resource columns and resource-local overlap lanes", () => {
  const occurrences = [
    occurrence("one","2026-11-10T09:00:00Z","2026-11-10T10:00:00Z"),
    occurrence("two","2026-11-10T09:30:00Z","2026-11-10T10:30:00Z"),
  ];
  const layout = layoutResourceTimeGrid(resources, occurrences, [
    {occurrenceId:"one",resourceIds:["a","b"]},
    {occurrenceId:"two",resourceIds:["a"]},
  ], {start:"2026-11-10T00:00:00Z",end:"2026-11-12T00:00:00Z"}, {
    timeZone:"UTC",startMinute:8*60,endMinute:18*60,
  });
  assert.deepEqual(layout.columns.map(c=>[c.dayKey,c.resourceId,c.columnIndex]),[
    ["2026-11-10","a",0],["2026-11-10","b",1],["2026-11-11","a",2],["2026-11-11","b",3],
  ]);
  assert.deepEqual(layout.timed.map(x=>[x.dayKey,x.resourceId,x.occurrenceId,x.column,x.columnCount]),[
    ["2026-11-10","a","one",0,2],["2026-11-10","a","two",1,2],["2026-11-10","b","one",0,1],
  ]);
  assert.equal(new Set(layout.timed.map(x=>x.renderId)).size,3);
});

test("Resource TimeGrid delegates civil/DST geometry to ordinary timed-day layout", () => {
  const spring = occurrence("spring","2026-03-08T07:00:00.000Z","2026-03-08T08:00:00.000Z");
  const range={start:"2026-03-08T05:00:00.000Z",end:"2026-03-09T04:00:00.000Z"};
  const ordinary=layoutTimedDay([spring],new Date("2026-03-08T05:00:00.000Z"),"America/New_York")[0];
  const resource=layoutResourceTimeGrid(resources,[spring],[{occurrenceId:"spring",resourceIds:["a"]}],range,{
    timeZone:"America/New_York",
  }).timed[0];
  assert.equal(resource.topMinutes,ordinary.topMinutes);
  assert.equal(resource.heightMinutes,ordinary.heightMinutes);
  assert.equal(resource.topMinutes,180);
});

test("Resource TimeGrid requires whole local-day ranges while accepting 23/25-hour DST days", () => {
  const spring=layoutResourceTimeGrid(resources,[],[],{
    start:"2026-03-08T05:00:00.000Z",end:"2026-03-09T04:00:00.000Z",
  },{timeZone:"America/New_York"});
  const fall=layoutResourceTimeGrid(resources,[],[],{
    start:"2026-11-01T04:00:00.000Z",end:"2026-11-02T05:00:00.000Z",
  },{timeZone:"America/New_York"});
  assert.deepEqual(spring.columns.map(column=>column.dayKey),["2026-03-08","2026-03-08"]);
  assert.deepEqual(fall.columns.map(column=>column.dayKey),["2026-11-01","2026-11-01"]);
  assert.throws(()=>layoutResourceTimeGrid(resources,[],[],{
    start:"2026-11-10T12:00:00.000Z",end:"2026-11-11T00:00:00.000Z",
  },{timeZone:"UTC"}),/local day boundaries/i);
  assert.throws(()=>layoutResourceTimeGrid(resources,[],[],{
    start:"2026-11-10T00:00:00.000Z",end:"2026-11-10T18:00:00.000Z",
  },{timeZone:"UTC"}),/local day boundaries/i);
});

test("Resource TimeGrid keeps points zero-duration, clips visible window and renders all-day assignments separately", () => {
  const point=occurrence("point","2026-11-10T09:15:00Z","2026-11-10T09:15:00Z",{temporalForm:"point"});
  const clipped=occurrence("clip","2026-11-10T07:30:00Z","2026-11-10T09:30:00Z");
  const allDay=occurrence("day","2026-11-10","2026-11-11",{allDay:true,precision:"date",temporal:{kind:"date"}});
  const layout=layoutResourceTimeGrid(resources,[point,clipped,allDay],[
    {occurrenceId:"point",resourceIds:["a"]},
    {occurrenceId:"clip",resourceIds:["a"]},
    {occurrenceId:"day",resourceIds:["b"]},
  ],{start:"2026-11-10T00:00:00Z",end:"2026-11-11T00:00:00Z"},{timeZone:"UTC",startMinute:8*60,endMinute:10*60});
  const p=layout.timed.find(x=>x.occurrenceId==="point");
  const c=layout.timed.find(x=>x.occurrenceId==="clip");
  assert.equal(p.heightMinutes,0);
  assert.deepEqual([c.topMinutes,c.heightMinutes],[480,90]);
  assert.deepEqual(layout.allDay.map(x=>[x.resourceId,x.occurrenceId]),[["b","day"]]);
});

test("Resource TimeGrid projects passive resource availability into matching columns only", () => {
  const layout=layoutResourceTimeGrid(resources,[],[],{
    start:"2026-11-10T00:00:00Z",end:"2026-11-11T00:00:00Z",
  },{
    timeZone:"UTC",startMinute:8*60,endMinute:18*60,
    availability:[
      {id:"a-open",definitionId:"open",resourceId:"a",state:"available",start:"2026-11-10T09:00:00Z",end:"2026-11-10T17:00:00Z"},
      {id:"b-block",definitionId:"blocked",resourceId:"b",state:"unavailable",start:"2026-11-10T12:00:00Z",end:"2026-11-10T13:00:00Z"},
    ],
  });
  assert.deepEqual(layout.availability.map(x=>[x.resourceId,x.topMinutes,x.heightMinutes,x.availability.state]),[
    ["a",540,480,"available"],["b",720,60,"unavailable"],
  ]);
});

test("Resource TimeGrid respects collapsed hierarchy, validates bounds and rejects oversized ranges", () => {
  const range={start:"2026-11-10T00:00:00Z",end:"2026-11-11T00:00:00Z"};
  assert.equal(layoutResourceTimeGrid(resources,[],[],range,{timeZone:"UTC",collapsedResourceIds:["group"]}).columns.length,0);
  assert.throws(()=>layoutResourceTimeGrid(resources,[],[],range,{timeZone:"UTC",startMinute:600,endMinute:500}),/visible minutes/i);
  assert.throws(()=>layoutResourceTimeGrid(resources,[],[],{
    start:"2026-01-01T00:00:00Z",end:"2026-02-15T00:00:00Z",
  },{timeZone:"UTC"}),/exceeds 31/i);
});


test("Resource TimeGrid availability fails closed on malformed or non-assignable projections", () => {
  const range={start:"2026-11-10T00:00:00Z",end:"2026-11-11T00:00:00Z"};
  const base={id:"open",definitionId:"definition",resourceId:"a",state:"available",start:"2026-11-10T09:00:00Z",end:"2026-11-10T10:00:00Z"};
  const layout=availability=>layoutResourceTimeGrid(resources,[],[],range,{timeZone:"UTC",availability});
  assert.throws(()=>layout([{...base,resourceId:"missing"}]),/unknown or non-assignable resource/i);
  assert.throws(()=>layout([{...base,resourceId:"group"}]),/unknown or non-assignable resource/i);
  assert.throws(()=>layout([{...base,state:"maybe"}]),/state is invalid/i);
  assert.throws(()=>layout([{...base,end:base.start}]),/must end after/i);
  assert.throws(()=>layout([base,{...base,resourceId:"b"}]),/duplicate Resource TimeGrid availability id/i);
});
