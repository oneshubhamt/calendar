import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as C from '../dist/index.js';
import {
  formatRecurrenceByDay,
  parseRecurrenceByDay,
  parseRecurrenceIntegerList,
  recurrenceAdvancedFields,
  recurrenceRuleFromEditor,
  recurrenceUntilFromEditor,
} from '../dist/view/recurrence-editor.js';

const source={id:'personal',title:'Personal',visible:true,sourceType:'personal',removable:true};
function event(overrides={}){
  return {id:'e1',calendarId:'personal',title:'Event',start:'2026-01-30T09:00:00.000Z',end:'2026-01-30T10:00:00.000Z',kind:'event',ownership:'calendar',editPolicy:'full',...overrides};
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
  assert.deepEqual(rule.byWeekday,[1,3]);
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

test('base UI wires month overflow, year/list views and dual-edge resizing without host semantics',async()=>{
  const sourceText=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  const editorText=await fs.readFile(new URL('../src/view/event-editor.ts',import.meta.url),'utf8');
  assert.match(sourceText,/more\.addEventListener\("click"[\s\S]*openMonthOverflow/);
  assert.match(sourceText,/private openMonthOverflow/);
  assert.match(sourceText,/\["month", "week", "day", "year", "agenda"\]/);
  assert.match(sourceText,/Day list/); assert.match(sourceText,/Week list/); assert.match(sourceText,/Month list/); assert.match(sourceText,/30-day list/);
  assert.match(sourceText,/dc-resize-start/); assert.match(sourceText,/dc-resize-end/);
  assert.match(sourceText,/resizePreview/); assert.match(sourceText,/resizeInterval/);
  assert.match(sourceText,/placementTimePatch/);
  assert.match(sourceText,/recurrenceChanged \? \{ recurrence: result\.recurrence \?\? null \} : \{\}/);
  assert.match(sourceText,/\(key === "c" \|\| key === "n"\) && this\.canCreateItems\(\)/);
  assert.match(editorText,/Advanced recurrence filters/);
  assert.match(editorText,/recurrenceRuleFromEditor/);
  assert.match(editorText,/sourceItem\?\.recurrence && !initial\.duplicate/);
  assert.match(editorText,/initialRecurrenceFormState/);
  assert.match(editorText,/recurrenceFormState\(\) === initialRecurrenceFormState && nextTemporal\.kind === sourceTemporal\.kind/);
  assert.match(editorText,/!initial\.duplicate && sourceItem\?\.recurrence\?\.exceptions/);
});


test('day and week render passive background ranges below every interactive time-grid layer',async()=>{
  const sourceText=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  const styles=await fs.readFile(new URL('../src/view/styles.ts',import.meta.url),'utf8');
  const types=await fs.readFile(new URL('../src/core/types.ts',import.meta.url),'utf8');

  assert.match(sourceText,/private backgroundRanges: readonly CalendarBackgroundRange\[\] = \[\]/);
  assert.match(sourceText,/this\.backgroundRanges = result\.backgroundRanges/);
  assert.match(sourceText,/private backgroundLayer\(day: Date\)/);
  assert.match(sourceText,/layoutBackgroundDay\([\s\S]*this\.backgroundRanges\.filter\(range => range\.allDay !== true\)/);
  assert.match(sourceText,/startMinute: this\.dayStartHour \* 60/);
  assert.match(sourceText,/endMinute: this\.dayEndHour \* 60/);
  assert.match(sourceText,/if \(inBounds\) column\.append\(this\.backgroundLayer\(day\)\);[\s\S]*const layouts = layoutTimedDay/);
  assert.match(sourceText,/background\.style\.top = .*layout\.topMinutes - visibleStart/);
  assert.match(sourceText,/background\.style\.height = .*layout\.heightMinutes/);
  assert.match(sourceText,/background\.style\.zIndex = String\(layout\.layer\)/);

  assert.match(styles,/\.dc-background-layer\{[^}]*pointer-events:none;z-index:0/);
  assert.match(styles,/\.dc-background-range\{[^}]*pointer-events:none/);
  assert.match(styles,/\.dc-selection-range\{[^}]*z-index:1/);
  assert.match(styles,/\.dc-time-event\{[^}]*z-index:2/);
  assert.match(styles,/\.dc-now\{[^}]*z-index:3/);

  assert.match(types,/interface CalendarBackgroundDisplay/);
  assert.match(types,/readonly color\?: string/);
  assert.match(types,/readonly textColor\?: string/);
  assert.match(types,/readonly className\?: string/);
  assert.match(sourceText,/--dc-background-range-color/);
  assert.match(sourceText,/--dc-background-range-fg/);
  assert.match(sourceText,/if \(isSafeHostClassName\(token\)\) element\.classList\.add\(token\)/);
  assert.match(sourceText,/el\("span", "dc-background-range-label", range\.label\)/);
  assert.doesNotMatch(sourceText,/background\.addEventListener/);
});


test('B4 renders only explicit all-day backgrounds in month cells and all-day lanes',async()=>{
  const sourceText=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  const styles=await fs.readFile(new URL('../src/view/styles.ts',import.meta.url),'utf8');
  const layout=await fs.readFile(new URL('../src/core/layout.ts',import.meta.url),'utf8');

  assert.match(layout,/groupAllDayBackgroundRangesByDay/);
  assert.match(layout,/if \(background\.allDay !== true\) continue/);
  assert.match(sourceText,/const backgroundBuckets = groupAllDayBackgroundRangesByDay\(this\.backgroundRanges, this\.timeZone, this\.visibleRange\)/);
  assert.match(sourceText,/if \(inBounds && dayBackgrounds\.length\) cell\.append\(this\.dayLevelBackgroundLayer\(dayBackgrounds\)\)/);
  assert.match(sourceText,/if \(inBounds && dayBackgrounds\.length\) all\.append\(this\.dayLevelBackgroundLayer\(dayBackgrounds\)\)/);
  assert.match(sourceText,/private dayLevelBackgroundLayer\(ranges: readonly CalendarBackgroundRange\[\]\)/);
  assert.match(sourceText,/layer\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(sourceText,/this\.backgroundAriaSuffix\(dayBackgrounds\)/);
  assert.match(sourceText,/\. Background: \$\{labels\.join\(", "\)\}/);
  assert.doesNotMatch(sourceText,/renderYear[\s\S]{0,1000}groupAllDayBackgroundRangesByDay/);
  assert.doesNotMatch(sourceText,/renderAgenda[\s\S]{0,1000}groupAllDayBackgroundRangesByDay/);

  assert.match(styles,/\.dc-day-background-layer\{[^}]*pointer-events:none;z-index:0/);
  assert.match(styles,/\.dc-day-background-range\{[^}]*pointer-events:none/);
  assert.match(styles,/\.dc-day-number\{[^}]*position:relative;z-index:1/);
  assert.match(styles,/\.dc-month-events\{[^}]*position:relative;z-index:1/);
  assert.match(styles,/\.dc-all-day-col\{[^}]*position:relative;overflow:hidden/);
  assert.match(styles,/\.dc-all-day-col>\.dc-event\{position:relative;z-index:1\}/);
  const dayBackgroundMethod=sourceText.match(/private dayLevelBackgroundLayer[\s\S]*?\n  }\n\n  private backgroundLayer/)?.[0] ?? '';
  assert.match(dayBackgroundMethod,/dc-day-background-layer/);
  assert.doesNotMatch(dayBackgroundMethod,/addEventListener/);
});


test('B6 centralizes optional placement guards across built-in, add-on and host-editor placement paths',async()=>{
  const sourceText=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  const types=await fs.readFile(new URL('../src/view/types.ts',import.meta.url),'utf8');
  const coreTypes=await fs.readFile(new URL('../src/core/types.ts',import.meta.url),'utf8');

  assert.match(coreTypes,/export interface CalendarPlacementGuard/);
  assert.match(coreTypes,/readonly mode: CalendarPlacementGuardMode/);
  assert.match(coreTypes,/readonly calendarId\?: CalendarId/);
  assert.match(types,/readonly placementGuards\?: readonly CalendarPlacementGuard\[\]/);

  const gate=sourceText.match(/private async allowPlacement\([\s\S]*?\n  }\n\n  private async keyboardTransformOccurrence/)?.[0] ?? '';
  assert.match(gate,/evaluatePlacementGuards\(this\.options\.placementGuards/);
  assert.match(gate,/placementInNavigationBounds/);
  assert.match(gate,/placementCollisions/);
  assert.match(gate,/guardEvaluation\.mode === "prevent"/);
  assert.match(gate,/warnings = \[\.\.\.guardEvaluation\.messages\]/);
  assert.match(gate,/confirmCalendarAction\(this\.host, "Scheduling check"/);
  assert.equal((gate.match(/confirmCalendarAction\(/g)??[]).length,1,'warn decisions and collision warnings should share one confirmation');

  assert.match(sourceText,/createHandler\(selection, this\.placementValidationPort\(\)\)/);
  assert.match(sourceText,/editHandler\(occurrence, this\.placementValidationPort\(\)\)/);
  assert.match(sourceText,/private placementValidationPort\(\): CalendarPlacementValidationPort/);
  assert.match(sourceText,/\.\.\.self\.placementValidationPort\(\)/);
  assert.match(types,/handleCreate\?: \(selection: CalendarSelection, placement: CalendarPlacementValidationPort\)/);
  assert.match(types,/handleEdit\?: \(occurrence: CalendarOccurrence, placement: CalendarPlacementValidationPort\)/);

  for(const marker of [
    'this.allowPlacement(nextStart, nextEnd, allDay, occurrence, "move")',
    'this.allowPlacement(start, nextEnd, allDay, occurrence, "resize")',
    'this.allowPlacement(this.resolveDraftTime(result.start, result.temporal), this.resolveDraftTime(result.end, result.temporal), result.allDay, occurrence, "edit", result.calendarId)',
    'self.allowPlacement(start, end, targetAllDay, occurrence, label.toLocaleLowerCase(), patch.calendarId ?? occurrence.calendarId)',
  ]) assert.equal(sourceText.includes(marker),true,`missing central placement gate: ${marker}`);

  assert.doesNotMatch(sourceText,/features\/availability/);
});
