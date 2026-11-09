import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as C from '../dist/index.js';
import * as Personal from '../dist/features/personal.js';

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
test('personal conveniences are explicit opt-in services rather than a view dependency',async()=>{
  const feature=Personal.PERSONAL_CALENDAR_FEATURE;
  const parsed=feature.parseQuickCreate('tomorrow 9am Review 30m',new Date('2026-12-09T00:00:00Z'),'Asia/Kolkata');
  assert.equal(parsed.title,'Review');
  assert.equal(parsed.kind,'event');
  const viewSource=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  assert.equal(viewSource.includes('features/personal'),false);
  for(const token of ['Quick add','Search calendar','Apply a routine','Copy to date','Move to date','New calendar']) assert.equal(viewSource.includes(token),false,`base view leaked optional personal UI: ${token}`);
  const personalUi=await fs.readFile(new URL('../src/features/personal-ui.ts',import.meta.url),'utf8');
  assert.match(personalUi,/Quick add/); assert.match(personalUi,/Copy to date/);
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
  const revisions=[];
  const unsubscribe=engine.subscribe(snapshot=>revisions.push(snapshot.revision));
  invalidate();
  assert.deepEqual(revisions,[4]);
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
