import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../dist/index.js';
import * as Planning from '../dist/features/planning.js';
import * as Personal from '../dist/features/personal.js';
import { canonicalValueString, sameCanonicalValue } from '../dist/core/canonical-value.js';

const source={id:'personal',title:'Personal',visible:true,sourceType:'personal',removable:true};
const event=(patch={})=>({id:'e1',calendarId:'personal',title:'Event',start:'2026-03-01T14:00:00.000Z',end:'2026-03-01T15:00:00.000Z',kind:'event',ownership:'calendar',editPolicy:'full',...patch});

test('canonical value comparison ignores object key order and optional undefined properties while preserving array order',()=>{
  const left={b:2,a:{z:3,y:undefined,x:1},optional:undefined,list:[1,2,3]};
  const right={list:[1,2,3],a:{x:1,z:3},b:2};
  assert.equal(sameCanonicalValue(left,right),true);
  assert.equal(canonicalValueString(left),canonicalValueString(right));
  assert.equal(sameCanonicalValue(left,{...right,list:[1,3,2]}),false);
  assert.equal(C.sameRecurrence(
    {rule:{frequency:'weekly',interval:2,byDay:[{weekday:1},{weekday:3}]}},
    {rule:{byDay:[{weekday:1},{weekday:3}],interval:2,frequency:'weekly'}},
  ),true);
});

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
  const unsubscribe=engine.subscribe(invalidation=>notifications.push(invalidation));
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
  assert.deepEqual(notifications,[{repositoryRevision:0,generation:1}]);
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
    {
      expected:/display color is invalid/i,
      ranges:[{id:'bad-display',start:'2026-11-10T09:00:00Z',end:'2026-11-10T10:00:00Z',display:{color:42}}],
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


test('background day geometry uses civil time, clips visibly and layers deterministically',()=>{
  const range=(id,start,end,patch={})=>({id,start,end,...patch});

  const normal=[
    range('broad','2026-11-09T23:00:00Z','2026-11-10T17:00:00Z'),
    range('narrow','2026-11-10T10:00:00Z','2026-11-10T11:00:00Z'),
    range('peer','2026-11-10T10:00:00Z','2026-11-10T12:00:00Z'),
    range('carry-out','2026-11-10T20:00:00Z','2026-11-11T03:00:00Z'),
    range('outside','2026-11-11T02:00:00Z','2026-11-11T03:00:00Z'),
  ];
  const options={timeZone:'UTC',startMinute:360,endMinute:1320};
  const layout=C.layoutBackgroundDay(normal,new Date('2026-11-10T12:00:00Z'),options);
  assert.deepEqual(layout.map(x=>x.range.id),['broad','peer','narrow','carry-out']);
  assert.deepEqual(layout.map(x=>[x.range.id,x.topMinutes,x.heightMinutes,x.layer]),[
    ['broad',360,660,0],
    ['peer',600,120,1],
    ['narrow',600,60,2],
    ['carry-out',1200,120,3],
  ]);
  assert.deepEqual(
    C.layoutBackgroundDay([...normal].reverse(),new Date('2026-11-10T12:00:00Z'),options).map(x=>x.range.id),
    layout.map(x=>x.range.id),
  );

  const istCarryIn=C.layoutBackgroundDay([
    range('ist-carry','2026-11-09T18:00:00Z','2026-11-10T04:30:00Z'),
  ],new Date('2026-11-10T06:30:00Z'),{timeZone:'Asia/Kolkata'});
  assert.deepEqual([istCarryIn[0].topMinutes,istCarryIn[0].heightMinutes],[0,600]);

  const spring=C.layoutBackgroundDay([
    range('spring','2026-03-08T06:30:00Z','2026-03-08T07:30:00Z'),
  ],new Date('2026-03-08T17:00:00Z'),{timeZone:'America/New_York'});
  assert.equal(spring[0].topMinutes,90);
  assert.equal(spring[0].heightMinutes,120);

  const fall=C.layoutBackgroundDay([
    range('fall','2026-11-01T04:30:00Z','2026-11-01T07:30:00Z'),
    range('repeated','2026-11-01T05:30:00Z','2026-11-01T06:30:00Z'),
  ],new Date('2026-11-01T17:00:00Z'),{timeZone:'America/New_York'});
  const fallById=new Map(fall.map(x=>[x.range.id,x]));
  assert.deepEqual([fallById.get('fall').topMinutes,fallById.get('fall').heightMinutes],[30,120]);
  assert.deepEqual([fallById.get('repeated').topMinutes,fallById.get('repeated').heightMinutes],[90,60]);

  assert.throws(
    ()=>C.layoutBackgroundDay([],new Date('2026-11-10T00:00:00Z'),{timeZone:'UTC',startMinute:600,endMinute:600}),
    /visible minutes/i,
  );

  const eventLayout=C.layoutTimedDay([
    C.occurrenceFromItem(event({id:'geometry-event',start:'2026-11-10T10:00:00Z',end:'2026-11-10T11:00:00Z'})),
  ],new Date('2026-11-10T12:00:00Z'),'UTC');
  assert.equal(eventLayout[0].columnCount,1);
});


test('explicit all-day backgrounds group by local day without promoting timed ranges',()=>{
  const ranges=[
    {id:'all-day',start:'2026-11-09T18:30:00.000Z',end:'2026-11-11T18:30:00.000Z',allDay:true},
    {id:'timed',start:'2026-11-10T03:30:00.000Z',end:'2026-11-10T04:30:00.000Z'},
    {id:'carry',start:'2026-11-08T18:00:00.000Z',end:'2026-11-09T19:00:00.000Z',allDay:true},
  ];
  const grouped=C.groupAllDayBackgroundRangesByDay(
    ranges,
    'Asia/Kolkata',
    {start:'2026-11-09T18:30:00.000Z',end:'2026-11-12T18:30:00.000Z'},
  );
  assert.deepEqual([...grouped.keys()],['2026-11-10','2026-11-11']);
  assert.deepEqual(grouped.get('2026-11-10').map(range=>range.id),['carry','all-day']);
  assert.deepEqual(grouped.get('2026-11-11').map(range=>range.id),['all-day']);
  assert.equal([...grouped.values()].flat().some(range=>range.id==='timed'),false);
});


test('placement guard evaluation composes allow warn prevent and fails closed',async()=>{
  const context={
    start:'2026-11-10T09:00:00.000Z',
    end:'2026-11-10T10:00:00.000Z',
    allDay:false,
    action:'create',
    timeZone:'UTC',
    calendarId:'personal',
  };

  const warned=await C.evaluatePlacementGuards([
    {id:'a',evaluate:()=>({mode:'allow'})},
    {id:'b',evaluate:()=>({mode:'warn',message:'Outside preferred hours.'})},
    {id:'c',evaluate:async()=>({mode:'warn'})},
  ],context);
  assert.deepEqual(warned,{
    mode:'warn',
    messages:['Outside preferred hours.','This placement may violate a scheduling policy.'],
  });

  let reached=false;
  const prevented=await C.evaluatePlacementGuards([
    {id:'p',evaluate:()=>({mode:'prevent',message:'Blocked by policy.'})},
    {id:'later',evaluate:()=>{reached=true;return {mode:'allow'};}},
  ],context);
  assert.deepEqual(prevented,{mode:'prevent',messages:['Blocked by policy.']});
  assert.equal(reached,false);

  for(const guards of [
    [{id:'dup',evaluate:()=>({mode:'allow'})},{id:'dup',evaluate:()=>({mode:'allow'})}],
    [{id:'bad',evaluate:()=>({mode:'maybe'})}],
    [{id:'throw',evaluate:()=>{throw new Error('offline');}}],
    [{id:'message',evaluate:()=>({mode:'warn',message:'   '})}],
  ]) {
    const result=await C.evaluatePlacementGuards(guards,context);
    assert.equal(result.mode,'prevent');
    assert.deepEqual(result.messages,['Scheduling policy could not be evaluated.']);
  }
});


test('event-only engine queries do not invoke passive background providers', async()=>{
  const source={id:'query-source',title:'Query source',visible:true};
  const repo=new C.MemoryCalendarRepository([source],[event({id:'query-event',calendarId:'query-source',start:'2026-11-10T09:00:00Z',end:'2026-11-10T10:00:00Z'})]);
  let backgroundCalls=0;
  const engine=new C.CalendarEngine(repo,[],[],[{
    id:'visual-only',
    projectBackgroundRanges(){
      backgroundCalls+=1;
      throw new Error('passive provider failure');
    },
  }]);
  const range={start:'2026-11-10T00:00:00Z',end:'2026-11-11T00:00:00Z'};
  const eventOnly=await engine.query(range,{includeBackgroundRanges:false});
  assert.equal(eventOnly.occurrences.length,1);
  assert.deepEqual(eventOnly.backgroundRanges,[]);
  assert.equal(backgroundCalls,0);
  await assert.rejects(()=>engine.query(range),/passive provider failure/i);
  assert.equal(backgroundCalls,1);
});


test('shared placement evaluation centralizes bounds guards and collisions with lazy event loading',async()=>{
  const base={
    start:'2026-11-10T09:00:00.000Z',
    end:'2026-11-10T10:00:00.000Z',
    allDay:false,
    action:'move',
    timeZone:'UTC',
    calendarId:'personal',
  };

  let loads=0;
  const outOfBounds=await C.evaluateCalendarPlacement(base,{
    navigationBounds:{min:'2026-11-11'},
    collisionPolicy:{mode:'prevent'},
    loadCollisionOccurrences:()=>{loads+=1;return [];},
  });
  assert.equal(outOfBounds.mode,'prevent');
  assert.match(outOfBounds.messages[0],/outside the allowed calendar date range/i);
  assert.equal(loads,0);

  const guardBlocked=await C.evaluateCalendarPlacement(base,{
    guards:[{id:'blocked',evaluate:()=>({mode:'prevent',message:'Policy block.'})}],
    collisionPolicy:{mode:'prevent'},
    loadCollisionOccurrences:()=>{loads+=1;return [];},
  });
  assert.deepEqual(guardBlocked.messages,['Policy block.']);
  assert.equal(loads,0);

  const collision=C.occurrenceFromItem(event({
    id:'occupied',
    title:'Occupied',
    start:'2026-11-10T09:30:00.000Z',
    end:'2026-11-10T10:30:00.000Z',
  }));
  const warned=await C.evaluateCalendarPlacement(base,{
    guards:[{id:'preference',evaluate:()=>({mode:'warn',message:'Outside preference.'})}],
    collisionPolicy:{mode:'warn'},
    loadCollisionOccurrences:()=>{loads+=1;return [collision];},
  });
  assert.equal(warned.mode,'warn');
  assert.deepEqual(warned.messages,['Outside preference.','It overlaps Occupied.']);
  assert.equal(warned.collisions.length,1);
  assert.equal(loads,1);

  const failed=await C.evaluateCalendarPlacement(base,{
    collisionPolicy:{mode:'prevent'},
    loadCollisionOccurrences:()=>{throw new Error('query failed');},
  });
  assert.equal(failed.mode,'prevent');
  assert.deepEqual(failed.messages,['Scheduling conflicts could not be evaluated.']);
});


test('generic snap and absolute-instant helpers are shared fail-closed core primitives',()=>{
  assert.equal(C.snapMinuteCoordinate(22,15,'round'),15);
  assert.equal(C.snapMinuteCoordinate(23,15,'round'),30);
  assert.equal(C.snapMinuteCoordinate(23,15,'floor'),15);
  assert.equal(C.snapMinuteCoordinate(23,15,'ceil'),30);
  assert.equal(C.snapMinuteCoordinate(23.5,15,'none'),23.5);
  assert.throws(()=>C.snapMinuteCoordinate(10,0,'round'),/slotMinutes/i);
  assert.throws(()=>C.snapMinuteCoordinate(Number.NaN,15,'round'),/finite/i);

  assert.deepEqual(C.normalizeSnapPolicy({
    move:'floor',resize:'ceil',selection:'none',keyboardStepMinutes:7,
  },15),{
    selection:'none',move:'floor',resize:'ceil',keyboardStepMinutes:7,
  });

  assert.equal(
    C.parseAbsoluteDateTime('2026-11-10T09:00:00+05:30').toISOString(),
    '2026-11-10T03:30:00.000Z',
  );
  assert.throws(()=>C.parseAbsoluteDateTime('2026-11-10T09:00:00'),/absolute ISO date-time/i);
  assert.throws(()=>C.parseAbsoluteDateTime('not-a-dateZ'),/valid absolute ISO date-time/i);
});


test('repository snapshots are runtime-immutable, isolated at ingress and copy-on-write',()=>{
  const mutableSource={id:'immutable-source',title:'Immutable',visible:true,metadata:{nested:{value:'source'}}};
  const mutableItem={
    id:'immutable-item',calendarId:'immutable-source',title:'Original',
    start:'2026-11-10T09:00:00.000Z',end:'2026-11-10T10:00:00.000Z',
    kind:'event',ownership:'calendar',editPolicy:'full',
    metadata:{nested:{value:'item'}},
  };
  const repo=new C.MemoryCalendarRepository([mutableSource],[mutableItem]);
  const first=repo.read();

  mutableSource.title='Mutated outside';
  mutableSource.metadata.nested.value='mutated';
  mutableItem.title='Mutated outside';
  mutableItem.metadata.nested.value='mutated';

  assert.equal(first.sources[0].title,'Immutable');
  assert.equal(first.sources[0].metadata.nested.value,'source');
  assert.equal(first.items[0].title,'Original');
  assert.equal(first.items[0].metadata.nested.value,'item');
  assert.equal(Object.isFrozen(first),true);
  assert.equal(Object.isFrozen(first.sources),true);
  assert.equal(Object.isFrozen(first.items),true);
  assert.equal(Object.isFrozen(first.sources[0]),true);
  assert.equal(Object.isFrozen(first.items[0].metadata.nested),true);
  assert.throws(()=>{ first.items.push(mutableItem); },TypeError);
  assert.throws(()=>{ first.items[0].metadata.nested.value='escape'; },TypeError);
  assert.strictEqual(repo.read(),first,'reads reuse one immutable snapshot until state changes');

  const unchanged=first.items[0];
  repo.create({
    id:'second-item',calendarId:'immutable-source',title:'Second',
    start:'2026-11-10T11:00:00.000Z',end:'2026-11-10T12:00:00.000Z',
    kind:'event',ownership:'calendar',editPolicy:'full',
  });
  const second=repo.read();
  assert.notStrictEqual(second,first);
  assert.strictEqual(second.items[0],unchanged,'unchanged owned entities are structurally shared');
  assert.equal(second.revision,1);
});

test('RepositoryCommandHandler commits each logical command through one revision-guarded authoritative replacement',async()=>{
  const source={id:'atomic-source',title:'Atomic',visible:true};
  const series={
    id:'atomic-series',calendarId:'atomic-source',title:'Series',
    start:'2026-11-10T09:00:00.000Z',end:'2026-11-10T10:00:00.000Z',
    kind:'event',ownership:'calendar',editPolicy:'full',seriesId:'atomic-series',
    recurrence:{rule:{frequency:'daily',count:4}},
  };
  const base=new C.MemoryCalendarRepository([source],[series]);
  const occurrence=C.expandItem(series,{
    start:'2026-11-12T00:00:00.000Z',end:'2026-11-13T00:00:00.000Z',
  },{timeZone:'UTC'})[0];

  let snapshot=base.read();
  let replaces=0, directMutations=0;
  const repository={
    read:()=>snapshot,
    create(){directMutations+=1;throw new Error('authoritative create must not be called');},
    update(){directMutations+=1;throw new Error('authoritative update must not be called');},
    remove(){directMutations+=1;throw new Error('authoritative remove must not be called');},
    replace(){throw new Error('unguarded replace must not be called');},
    replaceAtRevision(items,expectedRevision){
      replaces+=1;
      assert.equal(expectedRevision,snapshot.revision);
      const next=new C.MemoryCalendarRepository(snapshot.sources,items);
      snapshot=Object.freeze({...next.read(),revision:snapshot.revision+1});
    },
  };
  const handler=new C.RepositoryCommandHandler(repository);
  await handler.execute({
    type:'move-occurrence',occurrence,
    start:'2026-11-12T11:00:00.000Z',end:'2026-11-12T12:00:00.000Z',
    scope:'this-and-following',
  },{now:'2026-11-01T00:00:00.000Z',timeZone:'UTC'});

  assert.equal(directMutations,0);
  assert.equal(replaces,1);
  assert.equal(snapshot.items.length,2);
  assert.deepEqual(snapshot.items.map(item=>item.recurrence?.rule.count),[2,2]);
});


test('revision-guarded repositories reject stale replacement without partial mutation',async()=>{
  const source={id:'revision-source',title:'Revision',visible:true};
  const first={
    id:'revision-a',calendarId:'revision-source',title:'A',
    start:'2026-11-10T09:00:00.000Z',end:'2026-11-10T10:00:00.000Z',
    kind:'event',ownership:'calendar',editPolicy:'full',
  };
  const repo=new C.MemoryCalendarRepository([source],[first]);
  const initial=repo.read();
  await repo.replaceAtRevision([{...first,title:'B'}],initial.revision);
  assert.equal(repo.read().revision,1);
  assert.equal(repo.read().items[0].title,'B');
  assert.throws(
    ()=>repo.replaceAtRevision([{...first,title:'stale'}],initial.revision),
    error=>error instanceof C.CalendarStaleRevisionError && error.code==='stale'
      && error.expectedRevision===0 && error.actualRevision===1,
  );
  assert.equal(repo.read().items[0].title,'B');
  assert.equal(repo.read().revision,1);
});

test('CalendarEngine separates durable repository revision from combined invalidation generation',async()=>{
  const source={id:'generation-source',title:'Generation',visible:true};
  const item={
    id:'generation-item',calendarId:'generation-source',title:'Event',
    start:'2026-11-10T09:00:00.000Z',end:'2026-11-10T10:00:00.000Z',
    kind:'event',ownership:'calendar',editPolicy:'full',
  };
  const repo=new C.MemoryCalendarRepository([source],[item]);
  let invalidateProjection;
  let providerSubscriptions=0, providerUnsubscriptions=0;
  const provider={
    id:'generation-projection',
    project:()=>[],
    subscribe(listener){
      providerSubscriptions+=1;
      invalidateProjection=listener;
      return ()=>{providerUnsubscriptions+=1;};
    },
  };
  const engine=new C.CalendarEngine(repo,[provider]);
  const firstSignals=[], secondSignals=[];
  const unsubscribeFirst=engine.subscribe(value=>firstSignals.push(value));
  const unsubscribeSecond=engine.subscribe(value=>secondSignals.push(value));
  assert.equal(providerSubscriptions,1,'multiple consumers share one upstream subscription');

  const firstQuery=await engine.query({start:'2026-11-10T00:00:00.000Z',end:'2026-11-11T00:00:00.000Z'});
  assert.equal(firstQuery.repositoryRevision,0);
  assert.equal(firstQuery.generation,0);
  assert.equal('revision' in firstQuery,false);

  repo.update('generation-item',{title:'Changed'});
  assert.deepEqual(firstSignals[0],{repositoryRevision:1,generation:1});
  assert.deepEqual(secondSignals[0],{repositoryRevision:1,generation:1});

  invalidateProjection();
  assert.deepEqual(firstSignals[1],{repositoryRevision:1,generation:2});
  assert.deepEqual(secondSignals[1],{repositoryRevision:1,generation:2});
  assert.equal(engine.generation(),2);

  const secondQuery=await engine.query({start:'2026-11-10T00:00:00.000Z',end:'2026-11-11T00:00:00.000Z'});
  assert.equal(secondQuery.repositoryRevision,1);
  assert.equal(secondQuery.generation,2);

  unsubscribeFirst();
  assert.equal(providerUnsubscriptions,0);
  unsubscribeSecond();
  assert.equal(providerUnsubscriptions,1,'upstream subscription is released after the final consumer');
});


test('delta undo preserves unrelated later item changes and redo reapplies only the owned delta',async()=>{
  const source={id:'delta-source',title:'Delta',visible:true};
  const a={
    id:'delta-a',calendarId:'delta-source',title:'A',
    start:'2026-11-10T09:00:00.000Z',end:'2026-11-10T10:00:00.000Z',
    kind:'event',ownership:'calendar',editPolicy:'full',
  };
  const b={...a,id:'delta-b',title:'B',start:'2026-11-10T11:00:00.000Z',end:'2026-11-10T12:00:00.000Z'};
  const repo=new C.MemoryCalendarRepository([source],[a,b]);
  const handler=new C.RepositoryCommandHandler(repo);

  await handler.execute({type:'update',id:'delta-a',patch:{title:'A edited'}},{now:'2026-11-01T00:00:00.000Z'});
  repo.update('delta-b',{title:'B external'});

  assert.equal(await handler.undo(),true);
  assert.deepEqual(repo.read().items.map(item=>[item.id,item.title]),[
    ['delta-a','A'],['delta-b','B external'],
  ]);

  assert.equal(await handler.redo(),true);
  assert.deepEqual(repo.read().items.map(item=>[item.id,item.title]),[
    ['delta-a','A edited'],['delta-b','B external'],
  ]);
});

test('delta undo and redo preserve split ordering while retaining unrelated appended items',async()=>{
  const source={id:'delta-series-source',title:'Series',visible:true};
  const series={
    id:'delta-series',calendarId:'delta-series-source',title:'Series',
    start:'2026-11-10T09:00:00.000Z',end:'2026-11-10T10:00:00.000Z',
    kind:'event',ownership:'calendar',editPolicy:'full',seriesId:'delta-series',
    recurrence:{rule:{frequency:'daily',count:4}},
  };
  const other={...series,id:'delta-other',seriesId:undefined,title:'Other',recurrence:undefined,start:'2026-11-10T13:00:00.000Z',end:'2026-11-10T14:00:00.000Z'};
  const repo=new C.MemoryCalendarRepository([source],[series,other]);
  const occurrence=C.expandItem(series,{
    start:'2026-11-12T00:00:00.000Z',end:'2026-11-13T00:00:00.000Z',
  },{timeZone:'UTC'})[0];
  const handler=new C.RepositoryCommandHandler(repo);
  await handler.execute({
    type:'move-occurrence',occurrence,
    start:'2026-11-12T11:00:00.000Z',end:'2026-11-12T12:00:00.000Z',
    scope:'this-and-following',
  },{now:'2026-11-01T00:00:00.000Z',timeZone:'UTC'});

  const tailId=repo.read().items.find(item=>item.id!=='delta-series'&&item.id!=='delta-other').id;
  repo.create({
    id:'delta-unrelated',calendarId:'delta-series-source',title:'Unrelated',
    start:'2026-11-10T15:00:00.000Z',end:'2026-11-10T16:00:00.000Z',
    kind:'event',ownership:'calendar',editPolicy:'full',
  });

  assert.equal(await handler.undo(),true);
  assert.deepEqual(repo.read().items.map(item=>item.id),['delta-series','delta-other','delta-unrelated']);
  assert.equal(repo.read().items[0].recurrence.rule.count,4);

  assert.equal(await handler.redo(),true);
  assert.deepEqual(repo.read().items.map(item=>item.id),['delta-series','delta-other',tailId,'delta-unrelated']);
  assert.deepEqual(repo.read().items.slice(0,3).map(item=>item.recurrence?.rule.count),[2,undefined,2]);
});

test('delta undo still fails closed when an affected item or Calendar source changes',async()=>{
  const source={id:'delta-guard-source',title:'Guard',visible:true};
  const item={
    id:'delta-guard-item',calendarId:'delta-guard-source',title:'Before',
    start:'2026-11-10T09:00:00.000Z',end:'2026-11-10T10:00:00.000Z',
    kind:'event',ownership:'calendar',editPolicy:'full',
  };

  const changedItemRepo=new C.MemoryCalendarRepository([source],[item]);
  const changedItemHandler=new C.RepositoryCommandHandler(changedItemRepo);
  await changedItemHandler.execute({type:'update',id:item.id,patch:{title:'Edited'}},{now:'2026-11-01T00:00:00.000Z'});
  changedItemRepo.update(item.id,{description:'External'});
  await assert.rejects(()=>changedItemHandler.undo(),/changed outside undo history/i);
  assert.equal(changedItemRepo.read().items[0].description,'External');

  const changedSourceRepo=new C.MemoryCalendarRepository([{...source,removable:true}],[item]);
  const changedSourceHandler=new C.RepositoryCommandHandler(changedSourceRepo);
  await changedSourceHandler.execute({type:'update',id:item.id,patch:{title:'Edited'}},{now:'2026-11-01T00:00:00.000Z'});
  changedSourceRepo.updateSource(source.id,{title:'Changed source'});
  await assert.rejects(()=>changedSourceHandler.undo(),/sources changed outside undo history/i);
});


test('command history is derived from the staged command result, not a later repository snapshot',async()=>{
  const source={id:'history-race-source',title:'History race',visible:true};
  const a={id:'history-race-a',calendarId:source.id,title:'A',start:'2026-11-10T09:00:00.000Z',end:'2026-11-10T10:00:00.000Z',kind:'event',ownership:'calendar',editPolicy:'full'};
  const b={id:'history-race-b',calendarId:source.id,title:'B',start:'2026-11-10T11:00:00.000Z',end:'2026-11-10T12:00:00.000Z',kind:'event',ownership:'calendar',editPolicy:'full'};
  const base=new C.MemoryCalendarRepository([source],[a,b]);

  const repository={
    read:()=>base.read(),
    create:item=>base.create(item),
    update:(id,patch)=>base.update(id,patch),
    remove:id=>base.remove(id),
    replace:items=>base.replace(items),
    replaceAtRevision(items,expectedRevision){
      base.replaceAtRevision(items,expectedRevision);
      // Simulate an unrelated authoritative change landing after the command commit
      // but before the command handler resumes from await.
      if(base.read().items.find(item=>item.id==='history-race-b')?.title==='B'){
        base.update('history-race-b',{title:'B external'});
      }
    },
  };

  const handler=new C.RepositoryCommandHandler(repository);
  await handler.execute({type:'update',id:'history-race-a',patch:{title:'A changed'}},{now:'2026-11-10T00:00:00.000Z'});
  assert.equal(base.read().items.find(item=>item.id==='history-race-b').title,'B external');

  assert.equal(await handler.undo(),true);
  assert.equal(base.read().items.find(item=>item.id==='history-race-a').title,'A');
  assert.equal(base.read().items.find(item=>item.id==='history-race-b').title,'B external');
});


test('observer failures cannot reclassify committed repository state or block sibling observers',()=>{
  const source={id:'observer-source',title:'Observer',visible:true};
  const item={id:'observer-item',calendarId:source.id,title:'Before',start:'2026-11-10T09:00:00.000Z',end:'2026-11-10T10:00:00.000Z',kind:'event',ownership:'calendar',editPolicy:'full'};
  const repo=new C.MemoryCalendarRepository([source],[item]);
  let secondCalls=0;
  repo.subscribe(()=>{throw new Error('observer failure');});
  repo.subscribe(()=>{secondCalls+=1;});
  assert.doesNotThrow(()=>repo.update(item.id,{title:'After'}));
  assert.equal(repo.read().items[0].title,'After');
  assert.equal(repo.read().revision,1);
  assert.equal(secondCalls,1);
});

test('one failing CalendarEngine subscriber cannot block later subscribers or repository mutation success',()=>{
  const source={id:'engine-observer-source',title:'Observer',visible:true};
  const repo=new C.MemoryCalendarRepository([source],[]);
  const engine=new C.CalendarEngine(repo);
  let secondCalls=0;
  engine.subscribe(()=>{throw new Error('engine observer failure');});
  engine.subscribe(()=>{secondCalls+=1;});
  assert.doesNotThrow(()=>repo.create({id:'engine-observer-item',calendarId:source.id,title:'Event',start:'2026-11-10T09:00:00.000Z',end:'2026-11-10T10:00:00.000Z',kind:'event',ownership:'calendar',editPolicy:'full'}));
  assert.equal(repo.read().revision,1);
  assert.equal(secondCalls,1);
  assert.equal(engine.generation(),1);
});


test('command staging owns create input before execute yields',async()=>{
  const source={id:'stage-own-source',title:'Stage ownership',visible:true};
  const repo=new C.MemoryCalendarRepository([source],[]);
  const handler=new C.RepositoryCommandHandler(repo);
  const item={id:'stage-own-item',calendarId:source.id,title:'Original',start:'2026-11-10T09:00:00.000Z',end:'2026-11-10T10:00:00.000Z',kind:'event',ownership:'calendar',editPolicy:'full',metadata:{nested:{value:'original'}}};
  const pending=handler.execute({type:'create',item},{now:'2026-11-10T00:00:00.000Z'});
  item.title='Caller mutation';
  item.metadata.nested.value='caller mutation';
  await pending;
  assert.equal(repo.read().items[0].title,'Original');
  assert.equal(repo.read().items[0].metadata.nested.value,'original');
});


test('one-off occurrence identity remains stable across movement without duplicating source identity as id',()=>{
  const base=event({id:'single'});
  const before=C.occurrenceFromItem(base,{timeZone:'UTC'});
  const after=C.occurrenceFromItem({
    ...base,
    start:'2026-03-01T16:00:00.000Z',
    end:'2026-03-01T17:00:00.000Z',
  },{timeZone:'UTC'});
  assert.equal(before.occurrenceId,'item:single');
  assert.equal(after.occurrenceId,before.occurrenceId);
  assert.equal(before.sourceItemId,'single');
  assert.equal(Object.hasOwn(before,'id'),false);
});
