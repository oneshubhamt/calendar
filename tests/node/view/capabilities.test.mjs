import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../../dist/index.js';
import {
  formatRecurrenceByDay,
  parseRecurrenceByDay,
  parseRecurrenceIntegerList,
  recurrenceAdvancedFields,
  recurrenceRuleFromEditor,
  recurrenceUntilFromEditor,
} from '../../../dist/view/recurrence-editor.js';
import { makeCalendarItem, makePersonalSource } from '../../fixtures/domain.mjs';

const source=makePersonalSource({removable:true});
function event(overrides={}){
  return makeCalendarItem({start:'2026-01-30T09:00:00.000Z',end:'2026-01-30T10:00:00.000Z',...overrides});
}

test('year and agenda list ranges are explicit, timezone-safe view contracts',()=>{
  const year=C.rangeForView('2026-11-08T12:00:00.000Z','year',1,'Asia/Kolkata');
  assert.equal(C.dateKey(year.start,'Asia/Kolkata'),'2026-01-01');
  assert.equal(C.dateKey(year.end,'Asia/Kolkata'),'2027-01-01');

  const day=C.rangeForView('2026-11-08T12:00:00.000Z','agenda',1,'Asia/Kolkata','day');
  assert.equal(C.daysBetween(day.start,day.end,'Asia/Kolkata'),1);
  const week=C.rangeForView('2026-11-08T12:00:00.000Z','agenda',1,'Asia/Kolkata','week');
  assert.equal(C.daysBetween(week.start,week.end,'Asia/Kolkata'),7);
  assert.equal(C.dateKey(week.start,'Asia/Kolkata'),'2026-11-02');
  const month=C.rangeForView('2026-11-08T12:00:00.000Z','agenda',1,'Asia/Kolkata','month');
  assert.equal(C.dateKey(month.start,'Asia/Kolkata'),'2026-11-01');
  assert.equal(C.dateKey(month.end,'Asia/Kolkata'),'2026-12-01');
  const rolling=C.rangeForView('2026-11-08T12:00:00.000Z','agenda',1,'Asia/Kolkata','30-days');
  assert.equal(C.daysBetween(rolling.start,rolling.end,'Asia/Kolkata'),30);
});

test('agenda list grouping includes carry-in and multi-day occurrences on every visible day',()=>{
  const carry=C.occurrenceFromItem(event({id:'carry',start:'2026-11-07T23:30:00.000Z',end:'2026-11-08T01:00:00.000Z'}));
  const allDay=C.occurrenceFromItem(event({id:'multi',start:'2026-11-08',end:'2026-11-10',allDay:true,precision:'date',temporal:{kind:'date'}}));
  const groups=C.groupAgendaByDay([carry,allDay],{start:'2026-11-08T00:00:00.000Z',end:'2026-11-10T00:00:00.000Z'},'UTC');
  assert.deepEqual(groups.map(group=>[group.date,group.occurrences.map(row=>row.sourceItemId)]),[
    ['2026-11-08',['carry','multi']],
    ['2026-11-09',['multi']],
  ]);
});

test('advanced recurrence editor parses every recurrence filter supported by the engine',()=>{
  assert.deepEqual(parseRecurrenceIntegerList('1, 15 -1','Month days',-31,31),[1,15,-1]);
  const byDay=parseRecurrenceByDay('MO, 2TU, -1FR, MO');
  assert.deepEqual(byDay,[{weekday:1},{weekday:2,ordinal:2},{weekday:5,ordinal:-1}]);
  assert.equal(formatRecurrenceByDay(byDay),'MO, 2TU, -1FR');

  const rule=recurrenceRuleFromEditor({
    frequency:'monthly',interval:1,weekStartsOn:1,checkedWeekdays:[1],startMonth:1,startMonthDay:30,
    advanced:{byMonthDay:'',byMonth:'',byDay:'MO,TU,WE,TH,FR',bySetPosition:'-1'},count:3,
  });
  assert.deepEqual(rule.byDay,[{weekday:1},{weekday:2},{weekday:3},{weekday:4},{weekday:5}]);
  assert.deepEqual(rule.bySetPosition,[-1]);
  assert.equal(rule.count,3);

  const item=event({seriesId:'e1',recurrence:{rule}});
  const occurrences=C.expandItem(item,{start:'2026-01-01T00:00:00Z',end:'2026-04-02T00:00:00Z'});
  assert.deepEqual(occurrences.map(row=>row.start.slice(0,10)),['2026-01-30','2026-02-27','2026-03-31']);
});

test('advanced recurrence editor rejects invalid combinations instead of publishing malformed rules',()=>{
  assert.throws(()=>parseRecurrenceIntegerList('0, 12','Month days',-31,31),/excluding 0/i);
  assert.throws(()=>parseRecurrenceByDay('MONDAY'),/RFC-style/i);
  assert.throws(()=>recurrenceRuleFromEditor({
    frequency:'weekly',interval:1,weekStartsOn:1,checkedWeekdays:[1],startMonth:1,startMonthDay:1,
    advanced:{byMonthDay:'',byMonth:'',byDay:'2TU',bySetPosition:''},
  }),/Ordinal BYDAY/i);
  assert.throws(()=>recurrenceRuleFromEditor({
    frequency:'monthly',interval:1,weekStartsOn:1,checkedWeekdays:[1],startMonth:1,startMonthDay:1,
    advanced:{byMonthDay:'',byMonth:'',byDay:'',bySetPosition:'-1'},
  }),/BYSETPOS requires/i);
});

test('placement conversion canonicalizes timed and all-day temporal state',()=>{
  const allDay=C.placementTimePatch(
    new Date('2026-11-08T18:30:00.000Z'),
    new Date('2026-11-09T18:30:00.000Z'),
    true,'Asia/Kolkata',
  );
  assert.deepEqual(allDay,{start:'2026-11-09',end:'2026-11-10',allDay:true,precision:'date',temporal:{kind:'date'}});
  const timed=C.placementTimePatch(
    new Date('2026-11-09T03:30:00.000Z'),
    new Date('2026-11-09T04:30:00.000Z'),
    false,'Asia/Kolkata',
  );
  assert.deepEqual(timed,{start:'2026-11-09T03:30:00.000Z',end:'2026-11-09T04:30:00.000Z',allDay:false,precision:'minute',temporal:{kind:'instant'}});
  assert.throws(()=>C.placementTimePatch(new Date('2026-11-09T04:30:00Z'),new Date('2026-11-09T04:30:00Z'),false,'UTC'),/end must be after start/i);
});

test('recurrence editor keeps date UNTIL values stable across negative-offset zones',()=>{
  assert.equal(recurrenceUntilFromEditor('2026-11-08','date','America/Los_Angeles'),'2026-11-08');
  assert.equal(recurrenceUntilFromEditor('2026-11-08','instant','America/Los_Angeles'),'2026-11-09T07:59:00.000Z');
  assert.equal(recurrenceUntilFromEditor('2026-11-08','zoned','America/Los_Angeles'),'2026-11-08T23:59:00');
  assert.equal(recurrenceUntilFromEditor('2026-11-08','floating','America/Los_Angeles'),'2026-11-08T23:59:00');
});

test('recurrence editor round-trips simple weekly BYDAY through weekday controls',()=>{
  const fields=recurrenceAdvancedFields({frequency:'weekly',byDay:[{weekday:1},{weekday:3}]});
  assert.equal(fields.byDay,'');
  const rule=recurrenceRuleFromEditor({
    frequency:'weekly',interval:1,weekStartsOn:1,checkedWeekdays:[1,3],startMonth:11,startMonthDay:9,
    advanced:fields,
  });
  assert.deepEqual(rule.byDay,[{weekday:1},{weekday:3}]);
});

test('range-bounded day grouping does not emit keys outside the requested view',()=>{
  const long=C.occurrenceFromItem(event({id:'long',start:'2025-01-01',end:'2027-01-01',allDay:true,precision:'date',temporal:{kind:'date'}}),{timeZone:'UTC'});
  const buckets=C.groupByDay([long],'UTC',{start:'2026-11-08T00:00:00.000Z',end:'2026-11-10T00:00:00.000Z'});
  assert.deepEqual([...buckets.keys()],['2026-11-08','2026-11-09']);
});

test('range-bounded day grouping respects exact non-midnight range overlap',()=>{
  const morning=C.occurrenceFromItem(event({id:'morning',start:'2026-11-08T09:00:00.000Z',end:'2026-11-08T10:00:00.000Z'}));
  const crossing=C.occurrenceFromItem(event({id:'crossing',start:'2026-11-08T11:30:00.000Z',end:'2026-11-08T12:30:00.000Z'}));
  const range={start:'2026-11-08T12:00:00.000Z',end:'2026-11-08T13:00:00.000Z'};
  const buckets=C.groupByDay([morning,crossing],'UTC',range);
  assert.deepEqual([...buckets.keys()],['2026-11-08']);
  assert.deepEqual(buckets.get('2026-11-08')?.timed.map(item=>item.sourceItemId),['crossing']);
  assert.equal(C.groupByDay([morning],'UTC',range).size,0);
});

test('resize geometry supports both edges and enforces a minimum duration',()=>{
  assert.deepEqual(C.resizePreview(60,30,'end',15),{offsetMinutes:0,heightMinutes:90});
  assert.deepEqual(C.resizePreview(60,15,'start',15),{offsetMinutes:15,heightMinutes:45});
  assert.deepEqual(C.resizePreview(60,100,'start',15),{offsetMinutes:45,heightMinutes:15});
  const start=new Date('2026-11-08T09:00:00.000Z');
  const end=new Date('2026-11-08T10:00:00.000Z');
  const clampedStart=C.resizeInterval(start,end,new Date('2026-11-08T11:00:00.000Z'),'start',15);
  assert.equal(clampedStart.start.toISOString(),'2026-11-08T09:45:00.000Z');
  assert.equal(clampedStart.end.toISOString(),end.toISOString());
  const clampedEnd=C.resizeInterval(start,end,new Date('2026-11-08T08:00:00.000Z'),'end',15);
  assert.equal(clampedEnd.start.toISOString(),start.toISOString());
  assert.equal(clampedEnd.end.toISOString(),'2026-11-08T09:15:00.000Z');
  const crossDay=C.resizeInterval(start,end,new Date('2026-11-09T08:30:00.000Z'),'end',15);
  assert.equal(crossDay.end.toISOString(),'2026-11-09T08:30:00.000Z');
});

test('drag-and-drop placement preserves configured snapping and collision policy',()=>{
  const snap=C.normalizeSnapPolicy({move:'floor',resize:'ceil',selection:'round',keyboardStepMinutes:10},15);
  assert.equal(C.snapWithPolicy(new Date('2026-11-08T09:22:00.000Z'),15,snap.move).toISOString(),'2026-11-08T09:15:00.000Z');
  const occupied=C.occurrenceFromItem(event({id:'occupied',start:'2026-11-08T09:30:00.000Z',end:'2026-11-08T10:30:00.000Z'}));
  const moving=C.occurrenceFromItem(event({id:'moving',start:'2026-11-08T08:00:00.000Z',end:'2026-11-08T09:00:00.000Z'}));
  const conflicts=C.placementCollisions(
    [occupied,moving],
    new Date('2026-11-08T10:00:00.000Z'),
    new Date('2026-11-08T11:00:00.000Z'),
    false,{mode:'prevent',includeAllDay:false},moving.occurrenceId,
  );
  assert.deepEqual(conflicts.map(row=>row.occurrence.sourceItemId),['occupied']);
  assert.deepEqual(C.placementCollisions([occupied],new Date('2026-11-08T10:00:00.000Z'),new Date('2026-11-08T11:00:00.000Z'),false,{mode:'allow'}),[]);
});

test('resize command keeps recurring occurrence scope and undo semantics intact',async()=>{
  const recurring=event({id:'series',seriesId:'series',recurrence:{rule:{frequency:'daily',count:3}}});
  const repo=new C.MemoryCalendarRepository([source],[recurring]);
  const handler=new C.RepositoryCommandHandler(repo);
  const occurrence=C.expandItem(recurring,{start:'2026-01-31T00:00:00Z',end:'2026-02-01T00:00:00Z'})[0];
  assert.ok(occurrence);
  await handler.execute({
    type:'resize-occurrence',occurrence,start:occurrence.start,end:'2026-01-31T10:30:00.000Z',scope:'this',
  },{now:'2026-01-01T00:00:00Z'});
  const expanded=C.expandItem(repo.read().items[0],{start:'2026-01-30T00:00:00Z',end:'2026-02-02T00:00:00Z'});
  assert.deepEqual(expanded.map(row=>[row.start.slice(0,10),(Date.parse(row.end)-Date.parse(row.start))/60000]),[
    ['2026-01-30',60],['2026-01-31',90],['2026-02-01',60],
  ]);
  assert.equal(await handler.undo(),true);
  assert.equal(repo.read().items[0].recurrence.exceptions,undefined);
});
