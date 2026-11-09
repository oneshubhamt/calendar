import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { resolveSecondaryTimeZone, secondaryTimeScaleLabels } from '../dist/view/time-zone-scale.js';

test('secondary time scale is optional and malformed IANA zones fail closed',()=>{
  assert.equal(resolveSecondaryTimeZone(undefined),undefined);
  assert.equal(resolveSecondaryTimeZone(' Asia/Kolkata '),'Asia/Kolkata');
  assert.throws(()=>resolveSecondaryTimeZone(''),/valid IANA time zone/i);
  assert.throws(()=>resolveSecondaryTimeZone('Mars/Olympus_Mons'),/Invalid IANA time zone/i);
});

test('secondary labels preserve half-hour offsets from primary wall-clock geometry',()=>{
  const day=new Date('2026-04-13T15:00:00.000Z'); // 2026-04-14 00:00 in Tokyo
  const [label]=secondaryTimeScaleLabels([day],'Asia/Tokyo','Asia/Kolkata',9,10,'en-US');
  assert.equal(label.text,'05:30');
  assert.equal(label.variesAcrossDays,false);
  assert.match(label.accessibleLabel,/09:00 is .*05:30 in Asia\/Kolkata/);
});

test('secondary labels expose civil-date rollover instead of hiding it',()=>{
  const day=new Date('2026-04-13T15:00:00.000Z'); // 2026-04-14 00:00 in Tokyo
  const [label]=secondaryTimeScaleLabels([day],'Asia/Tokyo','America/Los_Angeles',1,2,'en-US');
  assert.equal(label.text,'09:00 -1d');
  assert.match(label.accessibleLabel,/Tue, Apr 14 01:00 is Mon, Apr 13 09:00/);
});

test('week-scale conversion reports DST offset changes across visible primary days',()=>{
  const days=[new Date('2026-10-31T00:00:00.000Z'),new Date('2026-11-01T00:00:00.000Z')];
  const [label]=secondaryTimeScaleLabels(days,'UTC','America/New_York',7,8,'en-US');
  assert.equal(label.text,'03:00 / 02:00');
  assert.equal(label.variesAcrossDays,true);
  assert.match(label.accessibleLabel,/Oct 31 03:00/);
  assert.match(label.accessibleLabel,/Nov 1 02:00/);
});


test('primary civil-time geometry remains aligned to wall-clock labels across a spring-forward transition',async()=>{
  const C=await import('../dist/index.js');
  const item={id:'dst',calendarId:'calendar',title:'After jump',start:'2026-03-08T07:00:00.000Z',end:'2026-03-08T08:00:00.000Z',kind:'event',ownership:'calendar',editPolicy:'full'};
  const occurrence=C.occurrenceFromItem(item,{timeZone:'America/New_York'});
  const [layout]=C.layoutTimedDay([occurrence],new Date('2026-03-08T05:00:00.000Z'),'America/New_York');
  assert.equal(layout.topMinutes,180); // 03:00 wall time, not 120 elapsed minutes from midnight
  assert.equal(layout.heightMinutes,60);
});

test('secondary scale represents primary DST gaps and overlaps instead of inventing duplicate instants',()=>{
  const spring=secondaryTimeScaleLabels([new Date('2026-03-08T05:00:00.000Z')],'America/New_York','Asia/Kolkata',1,4,'en-US');
  assert.deepEqual(spring.map(label=>[label.hour,label.text,label.transition]),[
    [1,'11:30','none'],[2,'— gap','gap'],[3,'12:30','none'],
  ]);
  const [fall]=secondaryTimeScaleLabels([new Date('2026-11-01T04:00:00.000Z')],'America/New_York','Asia/Kolkata',1,2,'en-US');
  assert.equal(fall.text,'10:30 / 11:30');
  assert.equal(fall.transition,'overlap');
  assert.match(fall.accessibleLabel,/occurs twice/);
});
test('secondary scale remains a day/week display option rather than a second calendar model',async()=>{
  const types=await fs.readFile(new URL('../src/view/types.ts',import.meta.url),'utf8');
  const view=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  assert.match(types,/readonly secondaryTimeZone\?: string \| undefined/);
  assert.match(view,/this\.secondaryTimeZone = resolveSecondaryTimeZone\(options\.secondaryTimeZone\)/);
  assert.match(view,/const secondaryAxis = this\.secondaryTimeZone \? this\.secondaryTimeAxis\(days, this\.secondaryTimeZone\) : null/);
  assert.match(view,/else body\.append\(this\.renderTimeGrid\(this\.view === "week" \? 7 : 1\)\)/);
  assert.doesNotMatch(view,/renderMonth\([\s\S]{0,500}secondaryTimeZone/);
  assert.doesNotMatch(view,/renderAgenda\([\s\S]{0,500}secondaryTimeZone/);
});

test('secondary axis is additive chrome and does not replace primary grid labels or event layout',async()=>{
  const view=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  const styles=await fs.readFile(new URL('../src/view/styles.ts',import.meta.url),'utf8');
  assert.match(view,/Primary time scale: \$\{this\.timeZone\}/);
  assert.match(view,/Secondary time scale: \$\{timeZone\}/);
  assert.match(view,/shell\.append\(axis\);\s*if \(secondaryAxis\) shell\.append\(secondaryAxis\);\s*shell\.append\(content\)/);
  assert.match(styles,/\.dc-time-shell\.has-secondary-time-zone\{grid-template-columns:58px 72px minmax\(0,1fr\);min-width:792px\}/);
  assert.match(styles,/\.dc-secondary-time-axis-label\.is-variable/);
});

test('primary geometry, projection and command semantics continue to use only the primary zone',async()=>{
  const view=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  assert.match(view,/layoutTimedDay\(this\.displayOccurrences\(\), day, this\.timeZone\)/);
  assert.match(view,/this\.engine\.query\(projectionRange, \{[\s\S]{0,220}visibleSourceIds,[\s\S]{0,80}timeZone: this\.timeZone/);
  assert.match(view,/calendarOccurrenceCommandContext\(command, new Date\(\)\.toISOString\(\), this\.timeZone\)/);
  assert.doesNotMatch(view,/calendarOccurrenceCommandContext\([^\n]*secondaryTimeZone/);
  assert.doesNotMatch(view,/engine\.query\([^\n]*secondaryTimeZone/);
  assert.doesNotMatch(view,/layoutTimedDay\([^\n]*secondaryTimeZone/);
});

test('C7 generic time-scale path contains no host-domain semantic dependency',async()=>{
  const files=['../src/view/types.ts','../src/view/time-zone-scale.ts','../src/view/calendar-ui.ts','../src/view/styles.ts'];
  const text=(await Promise.all(files.map(file=>fs.readFile(new URL(file,import.meta.url),'utf8')))).join('\n');
  for(const token of ['Ayana','journey','habit','payment','nominal']) assert.equal(new RegExp(`\\b${token}\\b`,'i').test(text),false,`generic C7 path leaked ${token}`);
});
