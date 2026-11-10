import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as C from '../dist/index.js';
import * as Personal from '../dist/features/personal.js';
import * as Availability from '../dist/features/availability.js';

const sources=[
  {id:'ayana:journey',title:'Goa',visible:true,sourceType:'journey',readOnly:true,removable:false,metadata:{host:'travel'}},
  {id:'birch:notes',title:'Notes',visible:true,sourceType:'knowledge-base',readOnly:true,removable:false,metadata:{host:'desktop-notes'}},
  {id:'personal',title:'Personal',visible:true,sourceType:'personal',removable:true},
];

test('calendar engine accepts a read-only host snapshot port without local mutation methods',async()=>{
  const hostSource={id:'host',title:'Host',visible:true,sourceType:'native'};
  const hostItem={id:'native-1',calendarId:'host',title:'Native record',start:'2026-12-10T10:00:00Z',end:'2026-12-10T11:00:00Z',kind:'native-task',ownership:'host',editPolicy:'readonly'};
  const provider={read(){return {sources:[hostSource],items:[hostItem],revision:1};}};
  const engine=new C.CalendarEngine(provider);
  const result=await engine.query({start:'2026-12-10T00:00:00Z',end:'2026-12-11T00:00:00Z'});
  assert.equal(result.occurrences.length,1); assert.equal(result.occurrences[0].kind,'native-task');
  assert.equal(engine.canManageSources(),false);
});

test('generic core accepts host-defined kinds, ownership tags, source classes and metadata',()=>{
  const items=[
    {id:'trip-plan',calendarId:'ayana:journey',title:'Check into hotel',start:'2026-12-10T10:00:00Z',end:'2026-12-10T11:00:00Z',kind:'journey-plan',ownership:'ayana',editPolicy:'readonly',metadata:{journeyId:'goa',people:['Ravi','Ana'],nested:{phase:'away'}}},
    {id:'habit',calendarId:'ayana:journey',title:'Stretch',start:'2026-12-10T06:00:00Z',end:'2026-12-10T06:15:00Z',kind:'habit',ownership:'ayana',editPolicy:'generated'},
    {id:'note',calendarId:'birch:notes',title:'Project review',start:'2026-12-11',end:'2026-12-12',allDay:true,precision:'date',temporal:{kind:'date'},kind:'note-deadline',ownership:'birch',editPolicy:'readonly',metadata:{noteId:'n1'}},
  ];
  const repo=new C.MemoryCalendarRepository(sources,items);
  assert.deepEqual(repo.read().items.map(x=>x.kind),['journey-plan','habit','note-deadline']);
  assert.equal(repo.read().sources[0].sourceType,'journey');
  assert.match(Personal.searchableText(items[0],sources[0]),/Ravi/i);
  assert.match(Personal.searchableText(items[0],sources[0]),/travel/i);
});


test('host metadata is bounded JSON-like data and remains domain-opaque',()=>{
  const valid={id:'m',calendarId:'personal',title:'Metadata',start:'2026-12-10T10:00:00Z',end:'2026-12-10T11:00:00Z',kind:'custom',ownership:'host',editPolicy:'full',metadata:{trip:{id:'goa',tags:['beach',3,true,null]},optional:undefined}};
  const repo=new C.MemoryCalendarRepository([sources[2]],[valid]);
  assert.equal(repo.read().items[0].metadata.trip.id,'goa');
  const cyclic={}; cyclic.self=cyclic;
  assert.throws(()=>new C.MemoryCalendarRepository([sources[2]],[{...valid,id:'cycle',metadata:cyclic}]),/cycle/i);
  assert.throws(()=>new C.MemoryCalendarRepository([sources[2]],[{...valid,id:'nan',metadata:{value:Number.NaN}}]),/non-finite/i);
  assert.throws(()=>new C.MemoryCalendarRepository([sources[2]],[{...valid,id:'date-object',metadata:{value:new Date()}}]),/plain object/i);
});

test('filtering never reserves a semantic kind named history',()=>{
  const item={id:'h',calendarId:'personal',title:'History seminar',start:'2026-12-10T10:00:00Z',end:'2026-12-10T11:00:00Z',kind:'history',ownership:'museum-app',editPolicy:'full'};
  assert.equal(Personal.matchesCalendarFilter(item,{text:'history'},sources[2]),true);
  assert.equal(Personal.matchesCalendarFilter(item,{predicate:row=>row.kind!=='archived'},sources[2]),true);
});

test('quick-create semantic keywords are host configurable and absent by default',()=>{
  const generic=Personal.parseQuickCreate('tomorrow 8am hotel checkin 1h #Goa',new Date('2026-12-09T00:00:00Z'),'Asia/Kolkata');
  assert.equal(generic.kind,'event');
  const parsed=Personal.parseQuickCreate('tomorrow 8am hotel checkin 1h #Goa',new Date('2026-12-09T00:00:00Z'),'Asia/Kolkata',{kindKeywords:{hotel:'journey-plan'}});
  assert.equal(parsed.kind,'journey-plan');
  assert.equal(parsed.category,'Goa');
  assert.equal(parsed.title,'checkin');
});

test('routine primitives are generic and configurable rather than implicitly planned',()=>{
  const items=Personal.instantiateRoutine({id:'morning',title:'Morning',calendarId:'personal',ownership:'ayana-intent',editPolicy:'schedule-only',metadata:{journeyId:'goa'},blocks:[{title:'Walk',offsetMinutes:420,durationMinutes:30,metadata:{habitId:'walk'}}]},'2026-12-10','Asia/Kolkata','2026-12-01T00:00:00Z');
  assert.equal(items[0].kind,'event');
  assert.equal(items[0].ownership,'ayana-intent');
  assert.equal(items[0].editPolicy,'schedule-only');
  assert.equal(items[0].metadata.habitId,'walk');
  assert.equal(items[0].metadata.journeyId,'goa');
  assert.equal(items[0].metadata.relationRole,undefined);
});


test('reminder channels are host-extensible while built-in conventions remain usable',()=>{
  const item={id:'native',calendarId:'personal',title:'Native alert',start:'2026-12-10T10:00:00Z',end:'2026-12-10T11:00:00Z',kind:'event',ownership:'host',editPolicy:'full',reminders:[{id:'r',minutesBefore:5,channel:'native-desktop'}]};
  const repo=new C.MemoryCalendarRepository([sources[2]], [item]);
  assert.equal(repo.read().items[0].reminders[0].channel,'native-desktop');
});

test('source removal is an explicit capability, not an inferred default',()=>{
  const repo=new C.MemoryCalendarRepository([{id:'implicit',title:'Implicit',visible:true,sourceType:'host'}],[]);
  assert.throws(()=>repo.removeSource('implicit'),/not removable/i);
  const removable=new C.MemoryCalendarRepository([{id:'yes',title:'Yes',visible:true,sourceType:'host',removable:true}],[]);
  removable.removeSource('yes'); assert.equal(removable.read().sources.length,0);
});
test('personal conveniences remain explicit opt-in behavior',()=>{
  const feature=Personal.PERSONAL_CALENDAR_FEATURE;
  const parsed=feature.parseQuickCreate('tomorrow 9am Review 30m',new Date('2026-12-09T00:00:00Z'),'Asia/Kolkata');
  assert.equal(parsed.title,'Review');
  assert.equal(parsed.kind,'event');
});

test('generic root does not export Director or planning integrations',async()=>{
  const root=await import('../dist/index.js');
  assert.equal('createDirectorEcosystem' in root,false);
  assert.equal('StudyDirectorCalendarIntegration' in root,false);
  assert.equal('createDirectorFixtureEnvironment' in root,false);
  assert.equal('createPlanningUiExtension' in root,false);
  assert.equal('parseQuickCreate' in root,false);
  assert.equal('PERSONAL_CALENDAR_FEATURE' in root,false);
  assert.equal('IndexedDbCalendarRepository' in root,false);
  assert.equal('exportIcs' in root,false);
  assert.equal('GoogleCalendarSyncAdapter' in root,false);
});

test('generic source/view/core graph contains no Director semantic dependency',async()=>{
  const files=['src/core/types.ts','src/core/calendar-engine.ts','src/core/commands.ts','src/core/store.ts','src/view/calendar-ui.ts','src/view/event-editor.ts','src/view/recurrence-editor.ts'];
  const text=(await Promise.all(files.map(file=>fs.readFile(new URL(`../${file}`,import.meta.url),'utf8')))).join('\n');
  for(const token of ['study-director','revision-director','practice-desk','UPSC','relationRole === "planned"','kind === "deadline"','metadata?.category','categoryPlaceholder','DirectorCalendarEngine','DirectorCalendar','DIRECTOR_CALENDAR_CSS']) assert.equal(text.includes(token),false,`generic layer leaked ${token}`);
  const view=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  assert.equal(view.includes('features/personal'),false,'base view must not import optional personal feature');
  const personal=await fs.readFile(new URL('../src/features/personal.ts',import.meta.url),'utf8');
  for(const token of ['study-director','revision-director','practice-desk','UPSC','relationRole === "planned"','kind === "deadline"']) assert.equal(personal.includes(token),false,`optional personal feature leaked host-specific semantics: ${token}`);
  const coreTypes=await fs.readFile(new URL('../src/core/types.ts',import.meta.url),'utf8');
  for(const token of ['CalendarUiOptions','CalendarRoutineTemplate','CalendarPersonalFeaturePort','CalendarQuickCreate']) assert.equal(coreTypes.includes(token),false,`core type layer leaked optional UI contract: ${token}`);
});
test('clean builds cannot retain deleted compiled modules',async()=>{
  await assert.rejects(fs.access(new URL('../dist/core/personal.js',import.meta.url)));
});

test('generic public API uses application-neutral primary names',()=>{
  assert.equal(typeof C.CalendarEngine,'function');
  assert.equal(typeof C.CalendarUi,'function');
  assert.equal(typeof C.CALENDAR_CSS,'string');
  assert.equal('DirectorCalendarEngine' in C,false);
  assert.equal('DirectorCalendar' in C,false);
  assert.equal('DIRECTOR_CALENDAR_CSS' in C,false);
});

test('host projection invalidations participate in engine subscriptions without owning storage',()=>{
  const source={id:'host',title:'Host',visible:true,sourceType:'host',readOnly:true};
  const provider={read(){return {sources:[source],items:[],revision:4};}};
  let invalidate=()=>{};
  let unsubscribed=false;
  const projection={id:'host-projection',project(){return [];},subscribe(listener){invalidate=listener;return ()=>{unsubscribed=true;};}};
  const engine=new C.CalendarEngine(provider,[projection]);
  const invalidations=[];
  const unsubscribe=engine.subscribe(invalidation=>invalidations.push(invalidation));
  invalidate();
  assert.deepEqual(invalidations,[{repositoryRevision:4,generation:1}]);
  unsubscribe();
  assert.equal(unsubscribed,true);
});

test('combined projected data fails closed on identity and source-integrity violations',async()=>{
  const source={id:'host',title:'Host',visible:true,sourceType:'host',readOnly:true};
  const local={id:'same',calendarId:'host',title:'Local',start:'2026-12-10T10:00:00Z',end:'2026-12-10T11:00:00Z',kind:'host-item',ownership:'host',editPolicy:'readonly'};
  const repo=new C.MemoryCalendarRepository([source],[local]);
  const duplicate={...local,title:'Projected'};
  const duplicateEngine=new C.CalendarEngine(repo,[{id:'duplicate',project(){return [duplicate];}}]);
  await assert.rejects(()=>duplicateEngine.query({start:'2026-12-10T00:00:00Z',end:'2026-12-11T00:00:00Z'}),/Duplicate calendar item/);

  const unknown={...local,id:'unknown',calendarId:'missing'};
  const unknownEngine=new C.CalendarEngine(repo,[{id:'unknown-source',project(){return [unknown];}}]);
  await assert.rejects(()=>unknownEngine.query({start:'2026-12-10T00:00:00Z',end:'2026-12-11T00:00:00Z'}),/Unknown calendar source/);
});


test('optional availability semantics reuse Calendar recurrence and preserve passive background output',()=>{
  const definitions=[{
    id:'working-hours',
    state:'available',
    calendarId:'personal',
    label:'Working hours',
    start:'2026-11-09T09:00:00',
    end:'2026-11-09T17:00:00',
    temporal:{kind:'zoned',timeZone:'Asia/Kolkata'},
    recurrence:{
      rule:{frequency:'weekly',byDay:[1,2,3,4,5].map(weekday=>({weekday})),count:5},
      exceptions:[
        {originalStart:'2026-11-11T09:00:00',cancelled:true},
        {originalStart:'2026-11-12T09:00:00',replacement:{start:'2026-11-12T10:00:00',end:'2026-11-12T18:00:00',label:'Late hours'}},
      ],
    },
    display:{className:'availability-window'},
    metadata:{origin:'policy'},
  }];
  const ranges=Availability.expandAvailabilityDefinitions(
    definitions,
    {start:'2026-11-09T00:00:00.000Z',end:'2026-11-16T00:00:00.000Z'},
    {timeZone:'Asia/Kolkata'},
  );
  assert.deepEqual(ranges.map(range=>[range.start,range.end,range.label]),[
    ['2026-11-09T03:30:00.000Z','2026-11-09T11:30:00.000Z','Working hours'],
    ['2026-11-10T03:30:00.000Z','2026-11-10T11:30:00.000Z','Working hours'],
    ['2026-11-12T04:30:00.000Z','2026-11-12T12:30:00.000Z','Late hours'],
    ['2026-11-13T03:30:00.000Z','2026-11-13T11:30:00.000Z','Working hours'],
  ]);
  assert.equal(ranges[0].calendarId,'personal');
  assert.deepEqual(ranges[0].metadata.calendarAvailability,{definitionId:'working-hours',state:'available'});
  assert.equal(ranges[0].metadata.origin,'policy');
  assert.equal(ranges[0].display.className,'availability-window');
  assert.match(ranges[0].id,/^working-hours@/);
});

test('availability supports explicit all-day unavailability without inventing labels',()=>{
  const [range]=Availability.expandAvailabilityDefinitions([{
    id:'closed-day',
    state:'unavailable',
    start:'2026-11-14',
    end:'2026-11-15',
    allDay:true,
    metadata:{reason:'maintenance'},
  }],{start:'2026-11-13T18:30:00.000Z',end:'2026-11-15T18:30:00.000Z'},{timeZone:'Asia/Kolkata'});
  assert.equal(range.allDay,true);
  assert.equal(range.start,'2026-11-13T18:30:00.000Z');
  assert.equal(range.end,'2026-11-14T18:30:00.000Z');
  assert.equal(range.label,undefined);
  assert.deepEqual(range.metadata.calendarAvailability,{definitionId:'closed-day',state:'unavailable'});
  assert.equal(range.metadata.reason,'maintenance');
});

test('availability recurrence inherits Calendar DST semantics rather than implementing a second recurrence engine',()=>{
  const ranges=Availability.expandAvailabilityDefinitions([{
    id:'sunday-window',
    state:'available',
    start:'2026-03-01T01:30:00',
    end:'2026-03-01T03:30:00',
    temporal:{kind:'zoned',timeZone:'America/New_York'},
    recurrence:{rule:{frequency:'weekly',count:2}},
  }],{start:'2026-03-01T00:00:00.000Z',end:'2026-03-09T12:00:00.000Z'},{timeZone:'America/New_York'});
  assert.equal(ranges.length,2);
  assert.deepEqual([ranges[1].start,ranges[1].end],['2026-03-08T06:30:00.000Z','2026-03-08T07:30:00.000Z']);
  assert.equal((Date.parse(ranges[1].end)-Date.parse(ranges[1].start))/60000,60);
});

test('availability provider reads live authoritative definitions and forwards invalidation without owning state',()=>{
  let definitions=[{id:'open',state:'available',start:'2026-11-10T09:00:00Z',end:'2026-11-10T10:00:00Z'}];
  let invalidate=()=>{};
  let unsubscribed=false;
  const provider=Availability.createAvailabilityBackgroundProvider({
    id:'availability',
    timeZone:'UTC',
    definitions:()=>definitions,
    subscribe(listener){invalidate=listener;return ()=>{unsubscribed=true;};},
  });
  assert.deepEqual(provider.projectBackgroundRanges({start:'2026-11-10T00:00:00Z',end:'2026-11-11T00:00:00Z'}).map(range=>range.id),['open']);
  definitions=[{id:'closed',state:'unavailable',start:'2026-11-10T11:00:00Z',end:'2026-11-10T12:00:00Z'}];
  assert.deepEqual(provider.projectBackgroundRanges({start:'2026-11-10T00:00:00Z',end:'2026-11-11T00:00:00Z'}).map(range=>range.id),['closed']);
  let notified=0;
  const unsubscribe=provider.subscribe(()=>{notified+=1;});
  invalidate();
  assert.equal(notified,1);
  unsubscribe();
  assert.equal(unsubscribed,true);
});

test('availability definitions fail closed and remain an optional feature boundary',async()=>{
  assert.throws(()=>Availability.expandAvailabilityDefinitions(
    [{id:'date-without-all-day',state:'available',start:'2026-11-10',end:'2026-11-11'}],
    {start:'2026-11-10T00:00:00Z',end:'2026-11-12T00:00:00Z'},
    {timeZone:'UTC'},
  ),/require allDay/i);
  assert.throws(()=>Availability.expandAvailabilityDefinitions(
    [{id:'bad-state',state:'maybe',start:'2026-11-10T09:00:00Z',end:'2026-11-10T10:00:00Z'}],
    {start:'2026-11-10T00:00:00Z',end:'2026-11-11T00:00:00Z'},
    {timeZone:'UTC'},
  ),/state is invalid/i);
  assert.throws(()=>Availability.expandAvailabilityDefinitions(
    [
      {id:'duplicate',state:'available',start:'2026-11-10T09:00:00Z',end:'2026-11-10T10:00:00Z'},
      {id:'duplicate',state:'unavailable',start:'2026-11-10T11:00:00Z',end:'2026-11-10T12:00:00Z'},
    ],
    {start:'2026-11-10T00:00:00Z',end:'2026-11-11T00:00:00Z'},
    {timeZone:'UTC'},
  ),/Duplicate availability definition/i);

  const root=await import('../dist/index.js');
  assert.equal('expandAvailabilityDefinitions' in root,false);
  assert.equal('createAvailabilityBackgroundProvider' in root,false);
  const view=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  assert.equal(view.includes('features/availability'),false);
  const pkg=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(pkg.exports['./features/availability'].import,'./dist/features/availability.js');
});


test('availability placement guards are explicit opt-in policies over passive availability semantics',async()=>{
  const definitions=()=>[
    {id:'available-a',state:'available',calendarId:'personal',start:'2026-11-10T09:00:00Z',end:'2026-11-10T12:00:00Z'},
    {id:'available-b',state:'available',calendarId:'personal',start:'2026-11-10T12:00:00Z',end:'2026-11-10T17:00:00Z'},
    {id:'blocked',state:'unavailable',calendarId:'personal',start:'2026-11-10T13:00:00Z',end:'2026-11-10T14:00:00Z'},
    {id:'other-source',state:'unavailable',calendarId:'ayana:journey',start:'2026-11-10T10:00:00Z',end:'2026-11-10T11:00:00Z'},
  ];
  const requireAvailable=Availability.createAvailabilityPlacementGuard({
    id:'required-hours',timeZone:'UTC',definitions,policy:'require-available',mode:'prevent',
  });
  const context=(start,end,calendarId='personal')=>({start,end,allDay:false,action:'create',timeZone:'UTC',calendarId});

  assert.deepEqual(await requireAvailable.evaluate(context('2026-11-10T09:30:00Z','2026-11-10T12:30:00Z')),{mode:'allow'});
  assert.equal((await requireAvailable.evaluate(context('2026-11-10T12:30:00Z','2026-11-10T14:30:00Z'))).mode,'prevent');
  assert.equal((await requireAvailable.evaluate(context('2026-11-10T08:30:00Z','2026-11-10T09:30:00Z'))).mode,'prevent');
  assert.deepEqual(await requireAvailable.evaluate(context('2026-11-10T10:00:00Z','2026-11-10T11:00:00Z','ayana:journey')),{mode:'prevent',message:'This placement is outside available time.'});

  const warnUnavailable=Availability.createAvailabilityPlacementGuard({
    id:'avoid-blocked',timeZone:'UTC',definitions,policy:'exclude-unavailable',mode:'warn',message:'Preferred scheduling conflict.',
  });
  assert.deepEqual(await warnUnavailable.evaluate(context('2026-11-10T13:15:00Z','2026-11-10T13:45:00Z')),{mode:'warn',message:'Preferred scheduling conflict.'});
  assert.deepEqual(await warnUnavailable.evaluate(context('2026-11-10T12:00:00Z','2026-11-10T12:30:00Z')),{mode:'allow'});

  const point=await requireAvailable.evaluate(context('2026-11-10T11:00:00Z','2026-11-10T11:00:00Z'));
  assert.deepEqual(point,{mode:'allow'});

  const backgroundProvider=Availability.createAvailabilityBackgroundProvider({id:'visual-only',timeZone:'UTC',definitions});
  assert.equal('evaluate' in backgroundProvider,false,'visual availability provider must remain non-enforcing');
});

test('availability placement guard policy configuration fails closed at construction',()=>{
  assert.throws(()=>Availability.createAvailabilityPlacementGuard({
    id:'bad-policy',timeZone:'UTC',definitions:()=>[],policy:'maybe',mode:'prevent',
  }),/policy is invalid/i);
  assert.throws(()=>Availability.createAvailabilityPlacementGuard({
    id:'bad-mode',timeZone:'UTC',definitions:()=>[],policy:'exclude-unavailable',mode:'allow',
  }),/mode is invalid/i);
});
