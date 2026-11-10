import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../dist/index.js';
import {createDirectorFixtureEnvironment,DIRECTOR_FIXTURE_TIME_ZONE} from '../dist/fixtures/director.js';
import {DIRECTOR_ECOSYSTEM_SOURCES} from '../dist/integration/ecosystem.js';
import {StudyDirectorPlanCommandHandler} from '../dist/integration/study-director.js';

test('realistic fixtures project all three Director domains', async()=>{
  const fixture=createDirectorFixtureEnvironment();
  const result=await fixture.ecosystem.engine.query({start:'2026-11-06T00:00:00Z',end:'2026-11-21T00:00:00Z'},{visibleSourceIds:new Set(DIRECTOR_ECOSYSTEM_SOURCES.map(x=>x.id)),timeZone:DIRECTOR_FIXTURE_TIME_ZONE});
  assert.ok(result.occurrences.some(x=>x.ownership==='study-plan'));
  assert.ok(result.occurrences.some(x=>x.ownership==='study-history'));
  assert.ok(result.occurrences.some(x=>x.ownership==='revision-engine'));
  assert.ok(result.occurrences.some(x=>x.ownership==='practice-history'));
  assert.ok(result.occurrences.some(x=>x.kind==='exam'));
  const scheduledRevision=result.occurrences.find(x=>x.sourceItemId==='fixture:revision:scheduled');
  const scheduledMock=result.occurrences.find(x=>x.sourceItemId==='fixture:practice:scheduled');
  assert.ok(scheduledRevision); assert.ok(scheduledMock);
  assert.equal(fixture.ecosystem.sourceActions.actions(scheduledRevision).some(x=>x.id==='revision:start'),true);
  assert.equal(fixture.ecosystem.sourceActions.actions(scheduledMock).some(x=>x.id==='practice:launch'),true);
});

test('Study schedule creation writes through scheduleGateway and participates in undo', async()=>{
  const fixture=createDirectorFixtureEnvironment();
  const before=fixture.studyDirector.scheduleGateway.read().tasks.length;
  await fixture.ecosystem.commandHandler.execute({type:'create',item:{
    id:'calendar:new-study',calendarId:'study-director:plan',title:'Ethics answer writing',start:'2026-11-08T08:30:00.000Z',end:'2026-11-08T09:15:00.000Z',kind:'study-block',ownership:'calendar',editPolicy:'full',metadata:{category:'Ethics'}
  }},{now:'2026-11-08T00:00:00Z',timeZone:DIRECTOR_FIXTURE_TIME_ZONE});
  const rows=fixture.studyDirector.scheduleGateway.read().tasks;
  assert.equal(rows.length,before+1);
  const created=rows.find(row=>row.name==='Ethics answer writing');
  assert.ok(created); assert.equal(created.area,'Ethics'); assert.equal(created.start,'14:00');
  assert.equal(rows.at(-1).start,'02:00');
  assert.equal(await fixture.ecosystem.commandHandler.undo(),true);
  assert.equal(fixture.studyDirector.scheduleGateway.read().tasks.length,before);
});

test('source actions open, start revision and launch Practice Desk without rewriting due dates', async()=>{
  const fixture=createDirectorFixtureEnvironment();
  const range={start:'2026-11-08T00:00:00Z',end:'2026-11-10T00:00:00Z'};
  const projected=await fixture.ecosystem.engine.query(range,{visibleSourceIds:new Set(DIRECTOR_ECOSYSTEM_SOURCES.map(x=>x.id)),timeZone:DIRECTOR_FIXTURE_TIME_ZONE});
  const study=projected.occurrences.find(x=>x.ownership==='study-plan');
  assert.ok(study); const open=fixture.ecosystem.sourceActions.actions(study).find(x=>x.kind==='open'); assert.ok(open); await fixture.ecosystem.sourceActions.execute(open.id,study); assert.equal(fixture.opened.length,1);

  const revision=await fixture.ecosystem.revisionScheduler.schedule({obligationId:'obl-companies',title:'Companies Act review',start:'2026-11-08T10:30:00.000Z',durationMinutes:25,dueAt:'2026-11-08T03:30:00.000Z'});
  const revisionOcc=C.occurrenceFromItem(revision);
  await fixture.ecosystem.sourceActions.execute('revision:start',revisionOcc);
  assert.deepEqual(fixture.revisionDirector.startedTargets,[['obl-companies']]); assert.equal(revision.metadata.dueAt,'2026-11-08T03:30:00.000Z');
  const completedRevision=projected.occurrences.find(x=>x.calendarId==='revision-director:history');
  if(completedRevision) assert.equal(fixture.ecosystem.sourceActions.actions(completedRevision).some(x=>x.id==='revision:start'),false);

  const mock=await fixture.ecosystem.practiceScheduler.schedule({examId:'pfrda',paperId:'mock-4',title:'PFRDA Mock 4',start:'2026-11-09T08:30:00.000Z',durationMinutes:40});
  await fixture.ecosystem.sourceActions.execute('practice:launch',C.occurrenceFromItem(mock));
  assert.deepEqual(fixture.practiceDesk.launched,[{paperId:'mock-4',examId:'pfrda'}]);
});


test('Study Director write-back uses one canonical apply reconcile flush protocol with the mutation source',async()=>{
  let rows=[{id:'existing',start:'06:00',dur:30,name:'Existing',kind:'work',area:'General'}];
  const calls=[];
  const host={
    timeZone:'Asia/Kolkata',
    studyDayBoundaryHour:4,
    scheduleGateway:{
      read:()=>({tasks:rows.map(row=>({...row}))}),
      apply:async(next,options)=>{calls.push(['apply',options.source]);rows=next.map(row=>({...row}));},
      reconcile:async source=>{calls.push(['reconcile',source]);},
      flush:async()=>{calls.push(['flush']);},
    },
    studyDay:()=> '2026-11-08',
    readDailyRecords:()=>[],
    canMutate:()=>true,
  };
  const handler=new StudyDirectorPlanCommandHandler(host);
  await handler.execute({type:'create',item:{
    id:'calendar:protocol',calendarId:'study-director:plan',title:'Protocol check',
    start:'2026-11-08T03:30:00.000Z',end:'2026-11-08T04:00:00.000Z',
    kind:'study-block',ownership:'calendar',editPolicy:'full',metadata:{category:'General'},
  }},{now:'2026-11-08T00:00:00.000Z',timeZone:'Asia/Kolkata'});
  assert.deepEqual(calls,[
    ['apply','director-calendar-create'],
    ['reconcile','director-calendar-create'],
    ['flush'],
  ]);
});
