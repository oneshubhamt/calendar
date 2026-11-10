import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../dist/index.js';
import * as Planning from '../dist/features/planning.js';
import * as Personal from '../dist/features/personal.js';

const source={id:'personal',title:'Personal',visible:true,sourceType:'personal',removable:true};
const event=(patch={})=>({id:'e1',calendarId:'personal',title:'Event',start:'2026-03-01T14:00:00.000Z',end:'2026-03-01T15:00:00.000Z',kind:'event',ownership:'calendar',editPolicy:'full',...patch});

test('recurrence, DST and series edits remain deterministic', async()=>{
  const zoned=event({id:'dst',start:'2026-03-07T09:00:00',end:'2026-03-07T10:00:00',temporal:{kind:'zoned',timeZone:'America/New_York'},recurrence:{rule:{frequency:'daily',count:3}}});
  const occurrences=C.expandItem(zoned,{start:'2026-03-07T00:00:00Z',end:'2026-03-11T00:00:00Z'},{timeZone:'America/New_York'});
  assert.equal(occurrences.length,3);
  assert.equal(occurrences[0].start,'2026-03-07T14:00:00.000Z');
  assert.equal(occurrences[1].start,'2026-03-08T13:00:00.000Z');

  const series=event({id:'series',seriesId:'series',recurrence:{rule:{frequency:'daily',count:4}}});
  const repo=new C.MemoryCalendarRepository([source],[series]);
  const target=C.expandItem(series,{start:'2026-03-01T00:00:00Z',end:'2026-03-06T00:00:00Z'},{timeZone:'UTC'})[2];
  const handler=new C.RepositoryCommandHandler(repo);
  await handler.execute({type:'move-occurrence',occurrence:target,start:'2026-03-03T16:00:00.000Z',end:'2026-03-03T17:00:00.000Z',scope:'this-and-following'},{now:'2026-02-01T00:00:00Z',timeZone:'UTC'});
  assert.deepEqual(repo.read().items.map(item=>item.recurrence?.rule.count),[2,2]);
});

test('repository invariants, item policy and source capabilities fail closed', async()=>{
  assert.throws(()=>new C.MemoryCalendarRepository([source],[event({end:'2026-03-01T13:00:00Z'})]),/end after|must end/i);
  assert.throws(()=>new C.MemoryCalendarRepository([source],[event({reminders:[{id:'r',minutesBefore:5,channel:'browser'},{id:'r',minutesBefore:10,channel:'in-app'}]})]),/duplicate reminder/i);
  const readonlyRepo=new C.MemoryCalendarRepository([source],[event({editPolicy:'readonly'})]);
  const readonlyHandler=new C.RepositoryCommandHandler(readonlyRepo);
  await assert.rejects(()=>readonlyHandler.execute({type:'update',id:'e1',patch:{title:'Changed'}},{now:'2026-01-01T00:00:00Z'}),/not directly editable/);

  const scheduled=event({id:'scheduled',editPolicy:'schedule-only',ownership:'revision-plan'});
  const scheduleRepo=new C.MemoryCalendarRepository([source],[scheduled]);
  const scheduleHandler=new C.RepositoryCommandHandler(scheduleRepo);
  await assert.rejects(()=>scheduleHandler.execute({type:'update',id:'scheduled',patch:{title:'Changed'}},{now:'2026-01-01T00:00:00Z'}),/schedule-only/);
  await scheduleHandler.execute({type:'move-occurrence',occurrence:C.occurrenceFromItem(scheduled),start:'2026-03-01T16:00:00Z',end:'2026-03-01T17:00:00Z',scope:'all'},{now:'2026-01-01T00:00:00Z'});
  assert.equal(scheduleRepo.read().items[0].start,'2026-03-01T16:00:00.000Z');

  const locked={id:'locked',title:'Locked',visible:true,sourceType:'host-owned',readOnly:true,allowCreate:false,removable:false};
  const lockedItem=event({id:'locked-event',calendarId:'locked'});
  const lockedRepo=new C.MemoryCalendarRepository([source,locked],[lockedItem]);
  const lockedHandler=new C.RepositoryCommandHandler(lockedRepo);
  await assert.rejects(()=>lockedHandler.execute({type:'update',id:'locked-event',patch:{title:'Nope'}},{now:'2026-01-01T00:00:00Z'}),/read-only/i);
  await assert.rejects(()=>lockedHandler.execute({type:'create',item:event({id:'new-locked',calendarId:'locked'})},{now:'2026-01-01T00:00:00Z'}),/does not allow item creation|read-only/i);
  assert.throws(()=>lockedRepo.removeSource('locked'),/not removable/i);
});

test('undo and redo refuse to overwrite concurrent repository or source changes', async()=>{
  const repo=new C.MemoryCalendarRepository([source],[event()]);
  const handler=new C.RepositoryCommandHandler(repo);
  await handler.execute({type:'update',id:'e1',patch:{title:'Edited'}},{now:'2026-01-01T00:00:00Z'});
  repo.update('e1',{description:'External change'});
  await assert.rejects(()=>handler.undo(),/changed outside undo history/i);
  assert.equal(repo.read().items[0].description,'External change');

  const repo2=new C.MemoryCalendarRepository([source],[event()]);
  const handler2=new C.RepositoryCommandHandler(repo2);
  await handler2.execute({type:'update',id:'e1',patch:{title:'Edited'}},{now:'2026-01-01T00:00:00Z'});
  repo2.updateSource('personal',{title:'Renamed'});
  await assert.rejects(()=>handler2.undo(),/changed outside undo history/i);
  assert.equal(repo2.read().items[0].title,'Edited');
});

test('generic personal primitives preserve zoned wall time without inventing planning semantics',()=>{
  const patch=Personal.moveItemToDatePatch(event({start:'2026-03-07T09:00:00',end:'2026-03-07T10:00:00',temporal:{kind:'zoned',timeZone:'America/New_York'}}),'2026-03-09','America/New_York');
  assert.equal(patch.start,'2026-03-09T09:00:00');
  assert.equal(patch.end,'2026-03-09T10:00:00');
  assert.deepEqual(patch.temporal,{kind:'zoned',timeZone:'America/New_York'});
  const quick=Personal.parseQuickCreate('tomorrow 7am Reading 2h #Focus',new Date('2026-11-08T05:00:00Z'),'Asia/Kolkata');
  assert.equal(quick.kind,'event');
  assert.equal(quick.title,'Reading');
  assert.equal(quick.category,'Focus'); assert.equal((Date.parse(quick.end)-Date.parse(quick.start))/60000,120);
});

test('planning comparison remains available only through the optional planning feature',()=>{
  const planned=C.occurrenceFromItem(event({id:'p',metadata:{relationId:'r',relationRole:'planned',plannedMinutes:60}}));
  const actual=C.occurrenceFromItem(event({id:'a',metadata:{relationId:'r',relationRole:'actual',actualMinutes:50}}));
  assert.equal(Planning.plannedActualPairs([planned,actual])[0].varianceMinutes,-10);
  assert.equal('plannedActualPairs' in C,false);
});

test('whole-series edits from a later occurrence preserve the series anchor and temporal representation', async()=>{
  const floating=event({
    id:'floating-series',
    start:'2026-11-08T06:30:00',end:'2026-11-08T07:00:00',
    temporal:{kind:'floating'},seriesId:'floating-series',recurrence:{rule:{frequency:'daily',count:7}},
  });
  const repo=new C.MemoryCalendarRepository([source],[floating]);
  const occurrence=C.expandItem(floating,{start:'2026-11-10T00:00:00Z',end:'2026-11-11T00:00:00Z'},{timeZone:'Asia/Kolkata'})[0];
  const handler=new C.RepositoryCommandHandler(repo);
  await handler.execute({
    type:'update-occurrence',occurrence,
    patch:{start:'2026-11-10T06:45:00',end:'2026-11-10T07:15:00',temporal:{kind:'floating'}},scope:'all',
  },{now:'2026-11-01T00:00:00Z',timeZone:'Asia/Kolkata'});
  const saved=repo.read().items[0];
  assert.equal(saved.start,'2026-11-08T06:45:00');
  assert.equal(saved.end,'2026-11-08T07:15:00');
  assert.deepEqual(saved.temporal,{kind:'floating'});

  const zoned=event({id:'zoned-one',start:'2026-11-10T19:30:00',end:'2026-11-10T21:00:00',temporal:{kind:'zoned',timeZone:'Asia/Tokyo'}});
  const zonedRepo=new C.MemoryCalendarRepository([source],[zoned]);
  const zonedHandler=new C.RepositoryCommandHandler(zonedRepo);
  const zonedOccurrence=C.occurrenceFromItem(zoned,{timeZone:'Asia/Kolkata'});
  await zonedHandler.execute({type:'update-occurrence',occurrence:zonedOccurrence,patch:{start:'2026-11-10',end:'2026-11-11',allDay:true,precision:'date',temporal:{kind:'date'}},scope:'all'},{now:'2026-11-01T00:00:00Z',timeZone:'Asia/Kolkata'});
  const converted=zonedRepo.read().items[0];
  assert.equal(converted.start,'2026-11-10');
  assert.equal(converted.end,'2026-11-11');
  assert.deepEqual(converted.temporal,{kind:'date'});

  const instant=event({id:'instant-series',seriesId:'instant-series',recurrence:{rule:{frequency:'daily',count:4}}});
  const instantRepo=new C.MemoryCalendarRepository([source],[instant]);
  const instantHandler=new C.RepositoryCommandHandler(instantRepo);
  const instantOccurrence=C.expandItem(instant,{start:'2026-03-03T00:00:00Z',end:'2026-03-04T00:00:00Z'},{timeZone:'Asia/Kolkata'})[0];
  await instantHandler.execute({type:'update-occurrence',occurrence:instantOccurrence,patch:{start:'2026-03-03T16:00:00.000Z',end:'2026-03-03T17:00:00.000Z',temporal:{kind:'instant'}},scope:'all'},{now:'2026-02-01T00:00:00Z',timeZone:'Asia/Kolkata'});
  assert.equal(instantRepo.read().items[0].start,'2026-03-01T16:00:00.000Z');
  assert.equal(instantRepo.read().items[0].end,'2026-03-01T17:00:00.000Z');
});


test('schedule-only events may change temporal placement without gaining semantic edit authority',async()=>{
  const allDay=event({
    id:'scheduled-date',start:'2026-11-08',end:'2026-11-09',allDay:true,precision:'date',temporal:{kind:'date'},
    editPolicy:'schedule-only',ownership:'host-plan',
  });
  const repo=new C.MemoryCalendarRepository([source],[allDay]);
  const handler=new C.RepositoryCommandHandler(repo);
  const occurrence=C.occurrenceFromItem(allDay,{timeZone:'Asia/Kolkata'});
  const patch=C.placementTimePatch(new Date('2026-11-09T03:30:00.000Z'),new Date('2026-11-09T04:30:00.000Z'),false,'Asia/Kolkata');
  await handler.execute({type:'update-occurrence',occurrence,patch,scope:'all'},{now:'2026-11-01T00:00:00Z',timeZone:'Asia/Kolkata'});
  const saved=repo.read().items[0];
  assert.equal(saved.start,'2026-11-09T03:30:00.000Z');
  assert.equal(saved.end,'2026-11-09T04:30:00.000Z');
  assert.equal(saved.allDay,false);
  assert.equal(saved.precision,'minute');
  assert.deepEqual(saved.temporal,{kind:'instant'});
  await assert.rejects(()=>handler.execute({type:'update',id:saved.id,patch:{title:'Semantic change'}},{now:'2026-11-01T00:00:00Z'}),/schedule-only/i);
});

test('series split discards pre-split exception baggage and remaps only surviving tail exceptions',async()=>{
  const base=event({
    id:'split-series',seriesId:'split-series',
    recurrence:{rule:{frequency:'daily',count:5},exceptions:[
      {originalStart:'2026-03-02T14:00:00.000Z',cancelled:true},
      {originalStart:'2026-03-04T14:00:00.000Z',replacement:{title:'Tail exception'}},
    ]},
  });
  const repo=new C.MemoryCalendarRepository([source],[base]);
  const handler=new C.RepositoryCommandHandler(repo);
  const occurrence=C.expandItem(base,{start:'2026-03-03T00:00:00Z',end:'2026-03-04T00:00:00Z'},{timeZone:'UTC'})[0];
  assert.ok(occurrence);
  await handler.execute({
    type:'update-occurrence',occurrence,scope:'this-and-following',
    patch:{start:'2026-03-03T15:00:00.000Z',end:'2026-03-03T16:00:00.000Z',recurrence:base.recurrence},
  },{now:'2026-02-01T00:00:00Z',timeZone:'UTC'});
  const [head,tail]=repo.read().items;
  assert.equal(head.recurrence.exceptions.length,1);
  assert.equal(head.recurrence.exceptions[0].originalStart,'2026-03-02T14:00:00.000Z');
  assert.equal(tail.recurrence.rule.count,3);
  assert.equal(tail.recurrence.exceptions.length,1);
  assert.equal(tail.recurrence.exceptions[0].replacement.title,'Tail exception');
  assert.notEqual(tail.recurrence.exceptions[0].originalStart,'2026-03-02T14:00:00.000Z');
});


test('background range projections stay passive, canonical and fail closed', async()=>{
  const visible={id:'background-visible',title:'Visible',visible:true};
  const hidden={id:'background-hidden',title:'Hidden',visible:false};
  const repo=new C.MemoryCalendarRepository([visible,hidden],[]);
  let invalidate;
  const provider={
    id:'backgrounds',
    projectBackgroundRanges:()=>[
      {id:'work-window',start:'2026-11-10T09:00:00+05:30',end:'2026-11-10T17:00:00+05:30',calendarId:'background-visible',label:'Context',metadata:{origin:'host'}},
      {id:'hidden-window',start:'2026-11-10T04:00:00Z',end:'2026-11-10T05:00:00Z',calendarId:'background-hidden'},
      {id:'global-window',start:'2026-11-10T06:00:00Z',end:'2026-11-10T07:00:00Z',allDay:false},
      {id:'outside-window',start:'2026-11-12T06:00:00Z',end:'2026-11-12T07:00:00Z'},
    ],
    subscribe:listener=>{invalidate=listener; return ()=>{invalidate=undefined;};},
  };
  const engine=new C.CalendarEngine(repo,[],[],[provider]);
  const notifications=[];
  const unsubscribe=engine.subscribe(snapshot=>notifications.push(snapshot.revision));
  assert.equal(typeof invalidate,'function');

  const result=await engine.query({start:'2026-11-10T00:00:00Z',end:'2026-11-11T00:00:00Z'});
  assert.deepEqual(result.backgroundRanges.map(range=>range.id),['work-window','global-window']);
  assert.equal(result.backgroundRanges[0].start,'2026-11-10T03:30:00.000Z');
  assert.equal(result.backgroundRanges[0].end,'2026-11-10T11:30:00.000Z');
  assert.equal(result.occurrences.length,0);

  const withHidden=await engine.query(
    {start:'2026-11-10T00:00:00Z',end:'2026-11-11T00:00:00Z'},
    {visibleSourceIds:new Set(['background-visible','background-hidden'])},
  );
  assert.deepEqual(withHidden.backgroundRanges.map(range=>range.id),['work-window','hidden-window','global-window']);

  invalidate();
  assert.deepEqual(notifications,[0]);
  unsubscribe();
  assert.equal(invalidate,undefined);

  const invalidCases=[
    {
      expected:/absolute ISO date-time/i,
      ranges:[{id:'floating',start:'2026-11-10T09:00:00',end:'2026-11-10T10:00:00'}],
    },
    {
      expected:/must end after/i,
      ranges:[{id:'zero',start:'2026-11-10T09:00:00Z',end:'2026-11-10T09:00:00Z'}],
    },
    {
      expected:/unknown calendar source/i,
      ranges:[{id:'unknown-source',start:'2026-11-10T09:00:00Z',end:'2026-11-10T10:00:00Z',calendarId:'missing'}],
    },
    {
      expected:/label is invalid/i,
      ranges:[{id:'bad-label',start:'2026-11-10T09:00:00Z',end:'2026-11-10T10:00:00Z',label:'   '}],
    },
  ];
  for(const {expected,ranges} of invalidCases){
    const invalidEngine=new C.CalendarEngine(repo,[],[],[{id:'invalid',projectBackgroundRanges:()=>ranges}]);
    await assert.rejects(()=>invalidEngine.query({start:'2026-11-10T00:00:00Z',end:'2026-11-11T00:00:00Z'}),expected);
  }

  const duplicateEngine=new C.CalendarEngine(repo,[],[],[
    {id:'one',projectBackgroundRanges:()=>[{id:'duplicate',start:'2026-11-10T09:00:00Z',end:'2026-11-10T10:00:00Z'}]},
    {id:'two',projectBackgroundRanges:()=>[{id:'duplicate',start:'2026-11-10T11:00:00Z',end:'2026-11-10T12:00:00Z'}]},
  ]);
  await assert.rejects(
    ()=>duplicateEngine.query({start:'2026-11-10T00:00:00Z',end:'2026-11-11T00:00:00Z'}),
    /duplicate calendar background range/i,
  );
});
