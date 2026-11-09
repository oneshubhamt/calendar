import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as C from '../dist/index.js';
import { resolveOccurrenceCapabilities } from '../dist/core/authority.js';

const source={id:'calendar',title:'Calendar',visible:true};
function item(overrides={}) {
  return {
    id:'item',calendarId:'calendar',title:'Item',
    start:'2026-11-09T15:00:00.000Z',end:'2026-11-09T16:00:00.000Z',
    kind:'event',ownership:'calendar',editPolicy:'full',...overrides,
  };
}
function point(overrides={}) {
  const start=overrides.start ?? '2026-11-09T15:00:00.000Z';
  return item({end:start,temporalForm:'point',...overrides,start});
}

function occurrence(value) { return C.occurrenceFromItem(value,{timeZone:'UTC'}); }

test('point temporal form stores a true zero-duration instant and interval chronology remains strict',()=>{
  const value=point();
  const repo=new C.MemoryCalendarRepository([source],[value]);
  const saved=repo.read().items[0];
  assert.equal(saved.start,saved.end);
  assert.equal(saved.temporalForm,'point');
  const projected=occurrence(saved);
  assert.equal(projected.start,projected.end);
  assert.equal(projected.temporalForm,'point');
  assert.throws(()=>new C.MemoryCalendarRepository([source],[item({end:'2026-11-09T15:00:00.000Z'})]),/end after|must end/i);
  assert.throws(()=>new C.MemoryCalendarRepository([source],[point({end:'2026-11-09T15:30:00.000Z'})]),/point temporal form requires start and end to be identical/i);
  assert.throws(()=>new C.MemoryCalendarRepository([source],[point({start:'2026-11-09',end:'2026-11-09',allDay:true,precision:'date',temporal:{kind:'date'}})]),/point temporal form cannot be date-only or all-day/i);
});

test('recurring points expand at exact instants and obey half-open query bounds',()=>{
  const recurring=point({id:'series',seriesId:'series',recurrence:{rule:{frequency:'daily',count:3}}});
  const expanded=C.expandItem(recurring,{start:'2026-11-09T15:00:00.000Z',end:'2026-11-11T15:00:00.000Z'},{timeZone:'UTC'});
  assert.deepEqual(expanded.map(row=>[row.start,row.end]),[
    ['2026-11-09T15:00:00.000Z','2026-11-09T15:00:00.000Z'],
    ['2026-11-10T15:00:00.000Z','2026-11-10T15:00:00.000Z'],
  ]);
});

test('host-projected points are visible exactly inside the requested range without fake duration',async()=>{
  const repo=new C.MemoryCalendarRepository([{...source,readOnly:true}],[]);
  const projected=occurrence(point({id:'host',editPolicy:'readonly'}));
  const provider={id:'host-points',projectOccurrences(){return [projected];}};
  const engine=new C.CalendarEngine(repo,[],[provider]);
  const inside=await engine.query({start:'2026-11-09T15:00:00.000Z',end:'2026-11-09T15:00:01.000Z'});
  assert.equal(inside.occurrences.length,1);
  assert.equal(inside.occurrences[0].start,inside.occurrences[0].end);
  const before=await engine.query({start:'2026-11-09T14:59:59.000Z',end:'2026-11-09T15:00:00.000Z'});
  assert.equal(before.occurrences.length,0);
});

test('time-grid geometry lays simultaneous points side-by-side and beside duration blocks without assigning duration',()=>{
  const block=occurrence(item({id:'block',start:'2026-11-09T14:30:00.000Z',end:'2026-11-09T15:30:00.000Z'}));
  const p1=occurrence(point({id:'p1',title:'Point A'}));
  const p2=occurrence(point({id:'p2',title:'Point B'}));
  const layout=C.layoutTimedDay([block,p1,p2],'2026-11-09T00:00:00.000Z','UTC');
  const byId=new Map(layout.map(row=>[row.occurrence.sourceItemId,row]));
  assert.equal(byId.get('p1').topMinutes,15*60);
  assert.equal(byId.get('p1').heightMinutes,0);
  assert.equal(byId.get('p2').heightMinutes,0);
  assert.equal(byId.get('block').columnCount,3);
  assert.equal(byId.get('p1').columnCount,3);
  assert.equal(byId.get('p2').columnCount,3);
  assert.deepEqual(new Set([byId.get('block').column,byId.get('p1').column,byId.get('p2').column]).size,3);
});

test('point values participate in month/year day buckets and agenda ordering at their exact start time',()=>{
  const early=occurrence(point({id:'early',title:'Early',start:'2026-11-09T09:00:00.000Z'}));
  const later=occurrence(point({id:'later',title:'Later',start:'2026-11-09T15:00:00.000Z'}));
  const duration=occurrence(item({id:'duration',title:'Duration',start:'2026-11-09T12:00:00.000Z',end:'2026-11-09T13:00:00.000Z'}));
  const range={start:'2026-11-09T00:00:00.000Z',end:'2026-11-10T00:00:00.000Z'};
  const bucket=C.groupByDay([later,duration,early],'UTC',range).get('2026-11-09');
  assert.deepEqual(bucket.timed.map(row=>row.sourceItemId),['early','duration','later']);
  const agenda=C.groupAgendaByDay([later,duration,early],range,'UTC');
  assert.deepEqual(agenda[0].occurrences.map(row=>row.sourceItemId),['early','duration','later']);
});

test('points do not become scheduling-duration collisions',()=>{
  const marker=occurrence(point({id:'marker'}));
  const block=occurrence(item({id:'block',start:'2026-11-09T14:30:00.000Z',end:'2026-11-09T15:30:00.000Z'}));
  assert.deepEqual(C.placementCollisions([block],new Date(marker.start),new Date(marker.end),false,{mode:'prevent'}),[]);
  assert.deepEqual(C.placementCollisions([marker],new Date(block.start),new Date(block.end),false,{mode:'prevent'}),[]);
});

test('point geometry disables resize and all-day conversion even on the trusted-host path',()=>{
  const marker=occurrence(point({editPolicy:'readonly'}));
  const lockedSource={...source,readOnly:true};
  const capabilities=resolveOccurrenceCapabilities(marker,lockedSource,{capabilities(){return {
    commandPath:'trusted-host',canMove:true,canMoveBetweenAllDayAndTimed:true,canResizeStart:true,canResizeEnd:true,canOpen:true,canEdit:true,
  };}});
  assert.equal(capabilities.canMove,true);
  assert.equal(capabilities.canMoveBetweenAllDayAndTimed,false);
  assert.equal(capabilities.canResizeStart,false);
  assert.equal(capabilities.canResizeEnd,false);
});


test('point editor and duplication preserve the single-instant temporal form instead of fabricating a duration',async()=>{
  const editor=await fs.readFile(new URL('../src/view/event-editor.ts',import.meta.url),'utf8');
  const view=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  assert.match(editor,/const pointOccurrence = Boolean\(occurrence && occurrence\.temporalForm === "point"\)/);
  assert.match(editor,/nextEnd = pointOccurrence \? nextStart/);
  assert.match(editor,/const endValue = pointOccurrence\s*\? startValue/);
  assert.match(editor,/pointOccurrence \|\| \(occurrence && capabilities\.allowAllDayConversion === false\)/);
  assert.match(editor,/pointOccurrence \? \{ temporalForm: "point" as const \}/);
  assert.match(editor,/endDateField\.hidden = true/);
  assert.match(editor,/endTimeField\.hidden = true/);
  assert.match(view,/result\.temporalForm \? \{ temporalForm: result\.temporalForm \}/);
});
test('point-marker view contract remains accessible and narrow-screen-safe without host semantics',async()=>{
  assert.match(C.CALENDAR_CSS,/\.dc-time-point\{/);
  assert.match(C.CALENDAR_CSS,/\.dc-time-point[^}]*min-height:0/);
  assert.match(C.CALENDAR_CSS,/\.dc-time-point \.dc-occurrence-title[^}]*max-width:100%/);
  const view=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  assert.match(view,/event\.setAttribute\("role", "group"\)/);
  assert.match(view,/const main = el\("button", "dc-occurrence-main dc-time-event-main"\)/);
  assert.match(view,/point in time/);
  assert.match(view,/isPointOccurrence\(occurrence\) && allDay/);
  for(const token of ['Ayana','journey','intent','habit','payment','deadline']) assert.equal(new RegExp(`\\b${token}\\b`,'i').test(view),false,`generic view leaked ${token}`);
});
