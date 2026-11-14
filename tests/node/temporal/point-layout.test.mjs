import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../../dist/index.js';
import { resolveOccurrenceCapabilities } from '../../../dist/core/authority.js';

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


test('nearby point markers use visual lanes without acquiring temporal duration',()=>{
  const layouts=C.layoutTimedDay([
    occurrence(point({id:'near-a',start:'2026-11-09T15:00:00.000Z'})),
    occurrence(point({id:'near-b',start:'2026-11-09T15:05:00.000Z'})),
  ],new Date('2026-11-09T00:00:00.000Z'),'UTC');
  assert.deepEqual(layouts.map(row=>row.heightMinutes),[0,0]);
  assert.deepEqual(new Set(layouts.map(row=>row.visualLaneCount)),new Set([2]));
  assert.equal(new Set(layouts.map(row=>row.visualLane)).size,2);
});

test('civil timeline rejects spring gaps and explicitly disambiguates fall overlaps',()=>{
  const springDay=new Date('2026-03-08T05:00:00.000Z');
  assert.equal(C.civilMinuteResolution(springDay,150,'America/New_York').kind,'gap');
  assert.equal(C.instantAtCivilMinute(springDay,150,'America/New_York','earlier'),null);

  const fallDay=new Date('2026-11-01T04:00:00.000Z');
  const overlap=C.civilMinuteResolution(fallDay,90,'America/New_York');
  assert.equal(overlap.kind,'overlap');
  assert.equal(overlap.instants.length,2);
  const earlier=C.instantAtCivilMinute(fallDay,90,'America/New_York','earlier');
  const later=C.instantAtCivilMinute(fallDay,90,'America/New_York','later');
  assert.equal(later.getTime()-earlier.getTime(),60*60_000);
});
