import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as C from '../dist/index.js';

const range={start:'2026-11-09T00:00:00.000Z',end:'2026-11-10T00:00:00.000Z'};
const sources=[
  {id:'local',title:'Local',visible:true},
  {id:'items',title:'Item projection',visible:true,readOnly:true},
  {id:'host',title:'Occurrence projection',visible:true,readOnly:true},
];

function item(overrides={}) {
  return {
    id:'local-1',calendarId:'local',title:'Local event',
    start:'2026-11-09T08:00:00.000Z',end:'2026-11-09T09:00:00.000Z',
    kind:'event',ownership:'calendar',editPolicy:'full',...overrides,
  };
}

function projectedOccurrence(overrides={}) {
  const sourceItemId=overrides.sourceItemId ?? 'host-series';
  const start=overrides.start ?? '2026-11-09T10:00:00.000Z';
  return {
    sourceItemId,
    occurrenceId:overrides.occurrenceId ?? `${sourceItemId}@one`,
    calendarId:overrides.calendarId ?? 'host',title:overrides.title ?? 'Host occurrence',
    start,end:overrides.end ?? '2026-11-09T11:00:00.000Z',
    kind:overrides.kind ?? 'host-event',ownership:overrides.ownership ?? 'host',editPolicy:overrides.editPolicy ?? 'readonly',
    originalStart:overrides.originalStart ?? start,recurring:overrides.recurring ?? true,
    ...(overrides.projectionIdentity !== undefined ? {projectionIdentity:overrides.projectionIdentity} : {}),
  };
}

test('host-expanded recurring occurrences render exactly as projected and are never recurrence-expanded again',async()=>{
  const repo=new C.MemoryCalendarRepository(sources,[]);
  const projected=[
    projectedOccurrence({occurrenceId:'host-series@a',start:'2026-11-09T10:00:00.000Z',end:'2026-11-09T10:30:00.000Z'}),
    projectedOccurrence({occurrenceId:'host-series@b',start:'2026-11-09T15:00:00.000Z',end:'2026-11-09T15:30:00.000Z'}),
  ];
  const engine=new C.CalendarEngine(repo,[],[{id:'host-occurrences',projectOccurrences(){return projected;}}]);
  const result=await engine.query(range);
  assert.deepEqual(result.occurrences.map(row=>row.occurrenceId),['host-series@a','host-series@b']);
  assert.equal(result.occurrences.every(row=>row.recurring),true);
  assert.equal(result.occurrences.length,projected.length);
});

test('existing CalendarProjectionProvider recurrence expansion is unchanged',async()=>{
  const repo=new C.MemoryCalendarRepository(sources,[]);
  const series=item({id:'projected-series',calendarId:'items',title:'Projected series',seriesId:'projected-series',editPolicy:'readonly',recurrence:{rule:{frequency:'daily',count:3}},start:'2026-11-09T06:00:00.000Z',end:'2026-11-09T06:30:00.000Z'});
  const engine=new C.CalendarEngine(repo,[{id:'item-projection',project(){return [series];}}]);
  const result=await engine.query({start:'2026-11-09T00:00:00.000Z',end:'2026-11-12T00:00:00.000Z'});
  assert.equal(result.occurrences.length,3);
  assert.deepEqual(result.occurrences.map(row=>row.originalStart),[
    '2026-11-09T06:00:00.000Z','2026-11-10T06:00:00.000Z','2026-11-11T06:00:00.000Z',
  ]);
});

test('local items, item projections and host-expanded occurrence projections coexist',async()=>{
  const local=item();
  const projectedItem=item({id:'projected-item',calendarId:'items',title:'Projected item',start:'2026-11-09T09:00:00.000Z',end:'2026-11-09T09:30:00.000Z',editPolicy:'readonly'});
  const host=projectedOccurrence({occurrenceId:'host-series@mixed'});
  const repo=new C.MemoryCalendarRepository(sources,[local]);
  const engine=new C.CalendarEngine(repo,[{id:'items',project(){return [projectedItem];}}],[{id:'occurrences',projectOccurrences(){return [host];}}]);
  const result=await engine.query(range);
  assert.deepEqual(result.occurrences.map(row=>row.title),['Local event','Projected item','Host occurrence']);
});

test('duplicate projected occurrence identity fails closed',async()=>{
  const repo=new C.MemoryCalendarRepository(sources,[]);
  const duplicate=projectedOccurrence({occurrenceId:'duplicate'});
  const engine=new C.CalendarEngine(repo,[],[{id:'occurrences',projectOccurrences(){return [duplicate,{...duplicate,start:'2026-11-09T12:00:00.000Z',end:'2026-11-09T13:00:00.000Z'}];}}]);
  await assert.rejects(()=>engine.query(range),/Duplicate calendar occurrence: duplicate/);
});

test('unknown calendar source and malformed source-item identity fail closed',async()=>{
  const repo=new C.MemoryCalendarRepository(sources,[]);
  const unknownEngine=new C.CalendarEngine(repo,[],[{id:'unknown',projectOccurrences(){return [projectedOccurrence({calendarId:'missing'})];}}]);
  await assert.rejects(()=>unknownEngine.query(range),/Unknown calendar source: missing/);
  const malformedEngine=new C.CalendarEngine(repo,[],[{id:'bad-source-item',projectOccurrences(){return [projectedOccurrence({sourceItemId:''})];}}]);
  await assert.rejects(()=>malformedEngine.query(range),/source item id/i);
});

test('invalid projected occurrence chronology fails closed',async()=>{
  const repo=new C.MemoryCalendarRepository(sources,[]);
  const engine=new C.CalendarEngine(repo,[],[{id:'bad-time',projectOccurrences(){return [projectedOccurrence({start:'2026-11-09T12:00:00.000Z',end:'2026-11-09T11:00:00.000Z'})];}}]);
  await assert.rejects(()=>engine.query(range),/end after|must end/i);
});

test('occurrence projection queries receive the exact requested range and results are range-bounded',async()=>{
  const repo=new C.MemoryCalendarRepository(sources,[]);
  const seen=[];
  const engine=new C.CalendarEngine(repo,[],[{id:'bounded',projectOccurrences(requested){seen.push(requested);return [
    projectedOccurrence({occurrenceId:'inside'}),
    projectedOccurrence({sourceItemId:'outside-source',occurrenceId:'outside',start:'2026-11-11T10:00:00.000Z',end:'2026-11-11T11:00:00.000Z'}),
  ];}}]);
  const result=await engine.query(range);
  assert.deepEqual(seen,[range]);
  assert.deepEqual(result.occurrences.map(row=>row.occurrenceId),['inside']);
});

test('occurrence provider invalidation participates in Calendar refresh subscriptions',async()=>{
  const repo=new C.MemoryCalendarRepository(sources,[]);
  let invalidate=()=>{};
  let currentTitle='Before';
  let unsubscribed=false;
  const provider={
    id:'refreshable',
    projectOccurrences(){return [projectedOccurrence({title:currentTitle})];},
    subscribe(listener){invalidate=listener;return ()=>{unsubscribed=true;};},
  };
  const engine=new C.CalendarEngine(repo,[],[provider]);
  const refreshed=new Promise((resolve,reject)=>{
    const unsubscribe=engine.subscribe(()=>{engine.query(range).then(result=>{unsubscribe();resolve(result);},reject);});
  });
  currentTitle='After';
  invalidate();
  const result=await refreshed;
  assert.equal(result.occurrences[0].title,'After');
  assert.equal(unsubscribed,true);
});

test('opaque projected host identity survives without Calendar semantics',async()=>{
  const repo=new C.MemoryCalendarRepository(sources,[]);
  const identity={series:{key:'opaque-series'},occurrence:['opaque-slot',7],revision:12};
  const occurrence=projectedOccurrence({projectionIdentity:identity});
  const engine=new C.CalendarEngine(repo,[],[{id:'opaque',projectOccurrences(){return [occurrence];}}]);
  const result=await engine.query(range);
  assert.deepEqual(result.occurrences[0].projectionIdentity,identity);
  assert.strictEqual(result.occurrences[0].projectionIdentity,identity);
});

test('malformed opaque projected identity fails closed',async()=>{
  const repo=new C.MemoryCalendarRepository(sources,[]);
  const cyclic={}; cyclic.self=cyclic;
  const engine=new C.CalendarEngine(repo,[],[{id:'opaque-bad',projectOccurrences(){return [projectedOccurrence({projectionIdentity:cyclic})];}}]);
  await assert.rejects(()=>engine.query(range),/cycle/i);
});

test('malformed occurrence-only recurrence anchors and recurrence payloads fail closed',async()=>{
  const repo=new C.MemoryCalendarRepository(sources,[]);
  const badAnchor=new C.CalendarEngine(repo,[],[{id:'bad-anchor',projectOccurrences(){return [projectedOccurrence({originalStart:'not-a-date'})];}}]);
  await assert.rejects(()=>badAnchor.query(range),/original start must be an absolute ISO date-time/i);
  const unexpanded={...projectedOccurrence(),recurrence:{rule:{frequency:'daily'}}};
  const recurrenceEngine=new C.CalendarEngine(repo,[],[{id:'unexpanded',projectOccurrences(){return [unexpanded];}}]);
  await assert.rejects(()=>recurrenceEngine.query(range),/must already be recurrence-expanded/i);
});

test('generic core/view occurrence projection contains no host-domain semantic dependency',async()=>{
  const files=['src/core/types.ts','src/core/calendar-engine.ts','src/core/store.ts','src/view/calendar-ui.ts','src/view/types.ts'];
  const text=(await Promise.all(files.map(file=>fs.readFile(new URL(`../${file}`,import.meta.url),'utf8')))).join('\n');
  for(const token of ['Ayana','nominal','journey','intent','habit','payment']) assert.equal(new RegExp(`\\b${token}\\b`,'i').test(text),false,`generic projection path leaked ${token}`);
});
