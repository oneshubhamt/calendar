import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../dist/index.js';
import { CalendarCommandLifecycle } from '../dist/view/command-lifecycle.js';
import { occurrenceWithPreview } from '../dist/view/occurrence-preview.js';
import { resolveOccurrencePresentation } from '../dist/view/presentation.js';
import { safePresentationCss, safeAddonCss, calendarHostCss } from '../dist/view/extension-styles.js';

const source={id:'host',title:'Host',visible:true,readOnly:true};
function hostOccurrence(overrides={}) {
  const start=overrides.start ?? '2026-11-09T10:00:00.000Z';
  return {
    sourceItemId:overrides.sourceItemId ?? 'host-item',
    occurrenceId:overrides.occurrenceId ?? 'host-occurrence',
    calendarId:overrides.calendarId ?? 'host',title:'Host occurrence',start,
    end:overrides.end ?? '2026-11-09T11:00:00.000Z',kind:'event',ownership:'host',editPolicy:'readonly',
    originalStart:overrides.originalStart ?? start,recurring:overrides.recurring ?? false,
    ...overrides,
  };
}

test('occurrence projections require canonicalizable absolute instants and normalize offsets before range filtering',async()=>{
  const repo=new C.MemoryCalendarRepository([source],[]);
  const dateOnly=new C.CalendarEngine(repo,[],[{id:'date-only',projectOccurrences(){return [hostOccurrence({start:'2026-11-09',end:'2026-11-10',originalStart:'2026-11-09'})];}}]);
  await assert.rejects(()=>dateOnly.query({start:'2026-11-08T18:30:00.000Z',end:'2026-11-09T18:30:00.000Z'}),/absolute ISO date-time/i);
  const redundantId=new C.CalendarEngine(repo,[],[{id:'redundant-id',projectOccurrences(){return [{...hostOccurrence(),id:'redundant-item-id'}];}}]);
  await assert.rejects(()=>redundantId.query({start:'2026-11-09T00:00:00.000Z',end:'2026-11-10T00:00:00.000Z'}),/sourceItemId rather than a redundant item id/i);
  const offsetOccurrence=hostOccurrence({start:'2026-11-09T10:00:00+05:30',end:'2026-11-09T11:00:00+05:30',originalStart:'2026-11-09T10:00:00+05:30'});
  const engine=new C.CalendarEngine(repo,[],[{id:'offset',projectOccurrences(){return [offsetOccurrence];}}]);
  const inside=await engine.query({start:'2026-11-09T04:00:00.000Z',end:'2026-11-09T06:00:00.000Z'});
  assert.equal(inside.occurrences.length,1);
  assert.equal(inside.occurrences[0].start,'2026-11-09T04:30:00.000Z');
  assert.equal(inside.occurrences[0].end,'2026-11-09T05:30:00.000Z');
  const outside=await engine.query({start:'2026-11-09T18:30:00.000Z',end:'2026-11-10T18:30:00.000Z'});
  assert.equal(outside.occurrences.length,0);
});

test('one-off occurrence identity is stable across movement and does not duplicate source identity as id',()=>{
  const base={id:'single',calendarId:'host',title:'One off',start:'2026-11-09T10:00:00.000Z',end:'2026-11-09T11:00:00.000Z',kind:'event',ownership:'calendar',editPolicy:'full'};
  const before=C.occurrenceFromItem(base,{timeZone:'UTC'});
  const after=C.occurrenceFromItem({...base,start:'2026-11-09T12:00:00.000Z',end:'2026-11-09T13:00:00.000Z'},{timeZone:'UTC'});
  assert.equal(before.occurrenceId,'item:single');
  assert.equal(after.occurrenceId,before.occurrenceId);
  assert.equal(before.sourceItemId,'single');
  assert.equal(Object.hasOwn(before,'id'),false);
});

test('close point markers use visual lanes without acquiring temporal duration',()=>{
  const make=(id,start)=>C.occurrenceFromItem({id,calendarId:'host',title:id,start,end:start,temporalForm:'point',kind:'event',ownership:'calendar',editPolicy:'full'},{timeZone:'UTC'});
  const layouts=C.layoutTimedDay([make('a','2026-11-09T15:00:00.000Z'),make('b','2026-11-09T15:05:00.000Z')],new Date('2026-11-09T00:00:00.000Z'),'UTC');
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

test('host lifecycle distinguishes mutation rejection from committed refresh failure',async()=>{
  const lifecycle=new CalendarCommandLifecycle();
  const rejected=await lifecycle.run('a','move',()=>{throw new Error('reject');},{refresh(){}});
  assert.equal(rejected,'rejected');
  let committed=false;
  const refreshFailed=await lifecycle.run('b','move',()=>{committed=true;},{refresh(){throw new Error('offline');}});
  assert.equal(committed,true);
  assert.equal(refreshFailed,'committed-refresh-failed');
});

test('tentative occurrence geometry is stateful and can be reconstructed after authoritative re-render',()=>{
  const occurrence=hostOccurrence();
  const preview={patch:{start:'2026-11-09T12:00:00.000Z',end:'2026-11-09T13:00:00.000Z'}};
  const first=occurrenceWithPreview(occurrence,preview,'UTC');
  const refreshed=occurrenceWithPreview({...occurrence,title:'Fresh authoritative title'},preview,'UTC');
  assert.equal(first.start,'2026-11-09T12:00:00.000Z');
  assert.equal(refreshed.start,'2026-11-09T12:00:00.000Z');
  assert.equal(refreshed.title,'Fresh authoritative title');
  assert.equal(occurrence.start,'2026-11-09T10:00:00.000Z');
});

test('presentation extensions fail independently and presentation CSS cannot claim Calendar geometry',()=>{
  const errors=[];
  const occurrence=hostOccurrence();
  const resolved=resolveOccurrencePresentation([
    {presentOccurrence(){throw new Error('broken');}},
    {presentOccurrence(){return {subtitle:'still rendered'};}},
  ],occurrence,(index,error)=>errors.push([index,error.message]));
  assert.equal(resolved.subtitle.text,'still rendered');
  assert.deepEqual(errors,[[0,'broken']]);
  assert.match(safePresentationCss('.custom{opacity:.8;border-style:dashed}'),/\.dc-root \.custom\{opacity:\.8;border-style:dashed\}/);
  assert.equal(safePresentationCss('.custom{position:absolute;color:red}'),'');
  assert.equal(safePresentationCss('.custom{all:unset}'),'');
  assert.equal(safePresentationCss('.custom{animation:host 1s}'),'');
  assert.equal(safePresentationCss('@import url(https://example.invalid/host.css);'),'');
  assert.equal(safePresentationCss('.custom{color:red!important}'),'');
  assert.equal(safePresentationCss('.custom{color:red;/* bypass */position:absolute}'),'');
  assert.equal(safePresentationCss('.custom{color:red;--calendar-geometry:1}'),'');
  assert.equal(safePresentationCss('.custom} body{color:red}'),'');
  assert.equal(safeAddonCss('.tool} body{display:block}'),'');
  assert.equal(safeAddonCss('.addon{color:red!important}'),'');
  assert.equal(safeAddonCss('.addon{color:red;/* ambiguous */display:grid}'),'');
  const scoped=calendarHostCss([], [{id:'sample',styles:'.tool{display:grid;gap:4px}@media(max-width:600px){.tool,.extra{display:block}}'}]);
  assert.match(scoped,/\[data-calendar-addon="0"\] \.tool\{display:grid;gap:4px\}/);
  assert.match(scoped,/@media \(max-width:600px\)\{\[data-calendar-addon="0"\] \.tool,\[data-calendar-addon="0"\] \.extra\{display:block\}\}/);
  assert.equal(scoped.startsWith('.tool{'),false);
  assert.equal(scoped.includes('\n.tool{'),false);
});
