import test from 'node:test';
import assert from 'node:assert/strict';
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
