import test from 'node:test';
import assert from 'node:assert/strict';
import * as Core from '../dist/index.js';
import * as ICS from '../dist/interoperability/ics.js';
import * as Google from '../dist/interoperability/google-calendar.js';
import * as Sync from '../dist/interoperability/sync.js';
import * as Reminder from '../dist/interoperability/reminders.js';

const source={id:'personal',title:'Personal',visible:true,sourceType:'personal'};
const event=(patch={})=>({id:'e1',calendarId:'personal',title:'Event',start:'2026-03-01T14:00:00.000Z',end:'2026-03-01T15:00:00.000Z',kind:'event',ownership:'host-owned',editPolicy:'full',...patch});

test('sync fingerprints are canonical across equivalent property insertion order',()=>{
  const first=event({recurrence:{rule:{frequency:'weekly',interval:2,byDay:[{weekday:1},{weekday:3}]}}});
  const second=event({recurrence:{rule:{byDay:[{weekday:1},{weekday:3}],interval:2,frequency:'weekly'}}});
  assert.equal(Sync.fingerprintCalendarItem(first),Sync.fingerprintCalendarItem(second));
});

test('sync links retain full remote baselines only for recurring series',()=>{
  const ordinary=event();
  const identity={provider:'google',connectionId:'c',externalCalendarId:'remote',eventId:'g1'};
  const ordinaryLink=Sync.linkAfterSync(ordinary,{identity,item:ordinary,deleted:false,fingerprint:Sync.fingerprintCalendarItem(ordinary)},'2026-01-01T00:00:00Z');
  assert.equal(ordinaryLink.baseRemoteItem,undefined);

  const recurring=event({recurrence:{rule:{frequency:'weekly'}}});
  const recurringLink=Sync.linkAfterSync(recurring,{identity:{...identity,eventId:'g2'},item:recurring,deleted:false,fingerprint:Sync.fingerprintCalendarItem(recurring)},'2026-01-01T00:00:00Z');
  assert.deepEqual(recurringLink.baseRemoteItem,recurring);
});

test('ICS alarms round-trip, imports preserve host authority, and Google reminder defaults are explicit',()=>{
  const ics=ICS.exportIcs([event({reminders:[{id:'os',minutesBefore:30,channel:'external'}]})],{now:'2026-01-01T00:00:00Z'});
  assert.match(ics,/BEGIN:VALARM/); assert.match(ics,/TRIGGER:-PT30M/);
  const imported=ICS.importIcs(ics,{calendarId:'host-calendar',ownership:'ayana',editPolicy:'schedule-only',defaultKind:'journey-plan'}).items[0];
  assert.equal(imported.ownership,'ayana'); assert.equal(imported.editPolicy,'schedule-only'); assert.equal(imported.kind,'journey-plan');
  assert.equal(Google.itemToGoogleEvent(event()).reminders.useDefault,false);
  const importedDefault=Google.googleEventToCalendarItem({id:'g1',summary:'G',start:{dateTime:'2026-01-01T10:00:00Z'},end:{dateTime:'2026-01-01T11:00:00Z'},reminders:{useDefault:true}},'personal','conn',undefined,'remote',{ownership:'ayana',kind:'trip-plan',editPolicy:'schedule-only'});
  assert.equal(importedDefault.ownership,'ayana'); assert.equal(importedDefault.kind,'trip-plan'); assert.equal(importedDefault.editPolicy,'schedule-only');
  assert.equal(Sync.calendarInteropMetadata(importedDefault).reminderMode,'default');
  assert.equal(Google.itemToGoogleEvent(importedDefault).reminders.useDefault,true);
  const importedNone=Google.googleEventToCalendarItem({id:'g2',summary:'G',start:{dateTime:'2026-01-01T10:00:00Z'},end:{dateTime:'2026-01-01T11:00:00Z'},reminders:{useDefault:false}},'personal','conn');
  assert.equal(Google.itemToGoogleEvent(importedNone).reminders.useDefault,false);
});

test('interop metadata is namespaced and does not overwrite host metadata',()=>{
  const host=event({metadata:{app:'ayana',sourceId:'journey-7',nested:{kept:true}}});
  const linked=Sync.mergeSyncMetadata(host,{provider:'custom-provider',connectionId:'c',externalCalendarId:'x',eventId:'e'});
  assert.equal(linked.metadata.app,'ayana'); assert.equal(linked.metadata.sourceId,'journey-7'); assert.equal(linked.metadata.nested.kept,true);
  assert.equal(Sync.externalIdentityFromMetadata(linked).provider,'custom-provider');
  assert.equal(linked.metadata.externalProvider,undefined);
});

test('MemorySyncStateStore read returns an owned clone',()=>{
  const store=new Sync.MemorySyncStateStore();
  store.write({provider:'google',connectionId:'clone',mode:'publish',externalCalendarId:'remote',localCalendarId:'personal',links:[]});
  const first=store.read('clone');
  first.links.push?.({bad:true});
  first.connectionId='mutated';
  const second=store.read('clone');
  assert.equal(second.connectionId,'clone');
  assert.deepEqual(second.links,[]);
});

test('concurrent Google syncs for one connection serialize before remote mutation',async()=>{
  const repo=new Core.MemoryCalendarRepository([source],[event()]);
  const states=new Sync.MemorySyncStateStore();
  let inserts=0, active=0, maxActive=0;
  const transport={
    async listEvents(){active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,10));active--;return {items:[],nextSyncToken:'t'};},
    async getEvent(){throw Error('unused');},async listInstances(){return {items:[]};},
    async insertEvent(_c,e){inserts++;return {id:'g1',etag:'x',...e};},
    async updateEvent(){throw Error('unused');},async patchEvent(){throw Error('unused');},async deleteEvent(){throw Error('unused');},
  };
  const a=new Google.GoogleCalendarSyncAdapter(transport,repo,states,{id:'serialized',googleCalendarId:'remote',localCalendarId:'personal',mode:'publish'});
  const b=new Google.GoogleCalendarSyncAdapter(transport,repo,states,{id:'serialized',googleCalendarId:'remote',localCalendarId:'personal',mode:'publish'});
  await Promise.all([a.sync(),b.sync()]);
  assert.equal(maxActive,1);
  assert.equal(inserts,1);
});

test('Google 412 is converted to a structured sync conflict', async()=>{
  const base=event({title:'Base'}), local=event({title:'Local edit'});
  const remoteBase=Google.googleEventToCalendarItem({id:'g1',etag:'"e1"',summary:'Base',start:{dateTime:base.start},end:{dateTime:base.end},reminders:{useDefault:false}},'personal','conn','e1','remote-cal');
  const stateStore=new Sync.MemorySyncStateStore();
  await stateStore.write({provider:'google',connectionId:'conn',mode:'two-way',externalCalendarId:'remote-cal',localCalendarId:'personal',syncToken:'token-1',links:[{localItemId:'e1',identity:{provider:'google',connectionId:'conn',externalCalendarId:'remote-cal',eventId:'g1',etag:'"e1"'},baseLocalFingerprint:Sync.fingerprintCalendarItem(base),baseRemoteFingerprint:Sync.fingerprintCalendarItem(remoteBase),baseRemoteItem:remoteBase,status:'clean',lastSyncedAt:'2026-01-01T00:00:00Z'}]});
  const transport={
    async listEvents(){return {items:[],nextSyncToken:'token-2'};},
    async getEvent(){return {id:'g1',etag:'"e2"',summary:'Remote newer',start:{dateTime:base.start},end:{dateTime:base.end},reminders:{useDefault:false}};},
    async listInstances(){return {items:[]};}, async insertEvent(){throw Error('unexpected insert');},
    async updateEvent(){throw Error('unexpected update');}, async patchEvent(){throw new Google.GoogleCalendarHttpError(412,'Precondition Failed');}, async deleteEvent(){throw Error('unexpected delete');},
  };
  const repo=new Core.MemoryCalendarRepository([source],[local]);
  const sync=new Google.GoogleCalendarSyncAdapter(transport,repo,stateStore,{id:'conn',googleCalendarId:'remote-cal',localCalendarId:'personal',mode:'two-way',publishPredicate:item=>item.ownership==='host-owned'});
  const result=await sync.sync();
  assert.equal(result.conflicts.length,1); assert.equal(result.conflicts[0].reason,'precondition-failed'); assert.equal(result.state.syncToken,'token-1'); assert.equal(result.state.links[0].status,'conflict');
});

test('Google publish defaults to fully editable local records rather than a reserved ownership tag', async()=>{
  const repo=new Core.MemoryCalendarRepository([source],[event({ownership:'ayana',editPolicy:'full'}),event({id:'e2',ownership:'birch',editPolicy:'schedule-only'})]);
  const states=new Sync.MemorySyncStateStore(); const inserted=[];
  const transport={async listEvents(){return {items:[],nextSyncToken:'t'};},async getEvent(){throw Error('unused');},async listInstances(){return {items:[]};},async insertEvent(_c,e){inserted.push(e);return {id:`g${inserted.length}`,etag:'x',...e};},async updateEvent(){throw Error('unused');},async patchEvent(){throw Error('unused');},async deleteEvent(){throw Error('unused');}};
  const adapter=new Google.GoogleCalendarSyncAdapter(transport,repo,states,{id:'conn',googleCalendarId:'r',localCalendarId:'personal',mode:'publish'});
  await adapter.sync(); assert.equal(inserted.length,1);
});

test('concurrent reminder coordinators share one atomic delivery claim',async()=>{
  const repo=new Core.MemoryCalendarRepository([source],[event({
    start:'2026-01-02T10:00:00Z',end:'2026-01-02T11:00:00Z',
    reminders:[{id:'r',minutesBefore:60,channel:'in-app'}],
  })]);
  const receipts=new Reminder.MemoryReminderReceiptStore();
  let calls=0;
  const delivery={channel:'in-app',async deliver(){calls++;await new Promise(resolve=>setTimeout(resolve,10));return true;}};
  const options={engine:new Core.CalendarEngine(repo),receipts,deliveries:[delivery],timeZone:'UTC',lookBackMinutes:15};
  const [first,second]=await Promise.all([
    new Reminder.ReminderCoordinator(options).check(new Date('2026-01-02T09:00:00Z')),
    new Reminder.ReminderCoordinator(options).check(new Date('2026-01-02T09:00:00Z')),
  ]);
  assert.equal(calls,1);
  assert.equal(first.length+second.length,1);
});

test('failed reminder delivery remains retryable', async()=>{
  const repo=new Core.MemoryCalendarRepository([source],[event({start:'2026-01-02T10:00:00Z',end:'2026-01-02T11:00:00Z',reminders:[{id:'r',minutesBefore:60,channel:'in-app'}]})]);
  const receipts=new Reminder.MemoryReminderReceiptStore(); let calls=0;
  const coordinator=new Reminder.ReminderCoordinator({engine:new Core.CalendarEngine(repo),receipts,deliveries:[{channel:'in-app',deliver(){calls++;return calls>1;}}],timeZone:'UTC',lookBackMinutes:15});
  assert.equal((await coordinator.check(new Date('2026-01-02T09:00:00Z'))).length,0);
  assert.equal((await coordinator.check(new Date('2026-01-02T09:01:00Z'))).length,1); assert.equal(calls,2);
});


test('Google publish retry adopts its deterministic remote event after state-write failure',async()=>{
  const repo=new Core.MemoryCalendarRepository([source],[event()]);
  let durableState=null;
  let writeAttempts=0;
  const states={
    read(){return durableState?structuredClone(durableState):null;},
    write(state){
      writeAttempts++;
      if(writeAttempts===1) throw Error('simulated state write failure');
      durableState=structuredClone(state);
    },
    remove(){durableState=null;},
  };
  let remote=null;
  let insertAttempts=0;
  let recoveryReads=0;
  const transport={
    async listEvents(){return {items:[],nextSyncToken:'token'};},
    async getEvent(_calendarId,eventId){
      recoveryReads++;
      assert.equal(eventId,remote.id);
      return structuredClone(remote);
    },
    async listInstances(){return {items:[]};},
    async insertEvent(_calendarId,payload){
      insertAttempts++;
      if(remote) throw new Google.GoogleCalendarHttpError(409,'duplicate',JSON.stringify({error:{errors:[{reason:'duplicate'}]}}));
      remote={...payload,etag:'"remote-1"'};
      return structuredClone(remote);
    },
    async updateEvent(){throw Error('unused');},
    async patchEvent(){throw Error('unused');},
    async deleteEvent(){throw Error('unused');},
  };
  const adapter=new Google.GoogleCalendarSyncAdapter(transport,repo,states,{id:'crash-safe',googleCalendarId:'remote',localCalendarId:'personal',mode:'publish'});
  await assert.rejects(()=>adapter.sync(),/simulated state write failure/);
  assert.equal(insertAttempts,1);
  assert.match(remote.id,/^dcal[0-9a-v]{28}$/);
  assert.equal(remote.extendedProperties.private.calendarItemId,'e1');

  const result=await adapter.sync();
  assert.equal(insertAttempts,2);
  assert.equal(recoveryReads,1);
  assert.equal(result.pushed,1);
  assert.equal(result.state.links.length,1);
  assert.equal(result.state.links[0].identity.eventId,remote.id);
});

test('Google two-way retry reattaches its deterministic remote event without duplicating the local item',async()=>{
  const repo=new Core.MemoryCalendarRepository([source],[event()]);
  let durableState=null;
  let writeAttempts=0;
  const states={
    read(){return durableState?structuredClone(durableState):null;},
    write(state){
      writeAttempts++;
      if(writeAttempts===1) throw Error('simulated state write failure');
      durableState=structuredClone(state);
    },
    remove(){durableState=null;},
  };
  let remote=null;
  let insertAttempts=0;
  const transport={
    async listEvents(){return {items:remote?[structuredClone(remote)]:[],nextSyncToken:'token'};},
    async getEvent(){throw Error('unexpected recovery read');},
    async listInstances(){return {items:[]};},
    async insertEvent(_calendarId,payload){
      insertAttempts++;
      remote={...payload,etag:'"remote-1"'};
      return structuredClone(remote);
    },
    async updateEvent(){throw Error('unused');},
    async patchEvent(){throw Error('unused');},
    async deleteEvent(){throw Error('unused');},
  };
  const adapter=new Google.GoogleCalendarSyncAdapter(transport,repo,states,{id:'crash-safe-two-way',googleCalendarId:'remote',localCalendarId:'personal',mode:'two-way'});
  await assert.rejects(()=>adapter.sync(),/simulated state write failure/);
  assert.equal(insertAttempts,1);

  const result=await adapter.sync();
  assert.equal(insertAttempts,1);
  assert.equal(repo.read().items.length,1);
  assert.equal(repo.read().items[0].id,'e1');
  assert.equal(result.state.links.length,1);
  assert.equal(result.state.links[0].localItemId,'e1');
  assert.equal(result.state.links[0].identity.eventId,remote.id);
});


test('Google pull retry rebases an already-applied local change after sync-state checkpoint failure',async()=>{
  const base=event({title:'Base'});
  const remoteBaseEvent={id:'g1',etag:'"e1"',summary:'Base',start:{dateTime:base.start},end:{dateTime:base.end},reminders:{useDefault:false}};
  const remoteBase=Google.googleEventToCalendarItem(remoteBaseEvent,'personal','pull-retry','e1','remote');
  const initialState={
    provider:'google',connectionId:'pull-retry',mode:'import',externalCalendarId:'remote',localCalendarId:'personal',syncToken:'token-1',
    links:[{
      localItemId:'e1',
      identity:{provider:'google',connectionId:'pull-retry',externalCalendarId:'remote',eventId:'g1',etag:'"e1"'},
      baseLocalFingerprint:Sync.fingerprintCalendarItem(base),
      baseRemoteFingerprint:Sync.fingerprintCalendarItem(remoteBase),
      baseRemoteItem:remoteBase,
      status:'clean',lastSyncedAt:'2026-01-01T00:00:00Z',
    }],
  };
  let durableState=structuredClone(initialState),writeAttempts=0;
  const states={
    read(){return structuredClone(durableState);},
    write(state){writeAttempts++;if(writeAttempts===1)throw Error('simulated checkpoint failure');durableState=structuredClone(state);},
    remove(){durableState=null;},
  };
  const remoteChanged={id:'g1',etag:'"e2"',summary:'Remote v2',start:{dateTime:base.start},end:{dateTime:base.end},reminders:{useDefault:false}};
  const transport={
    async listEvents(){return {items:[structuredClone(remoteChanged)],nextSyncToken:'token-2'};},
    async getEvent(){throw Error('unused');},async listInstances(){return {items:[]};},
    async insertEvent(){throw Error('unused');},async updateEvent(){throw Error('unused');},async patchEvent(){throw Error('unused');},async deleteEvent(){throw Error('unused');},
  };
  const repo=new Core.MemoryCalendarRepository([source],[base]);
  const adapter=new Google.GoogleCalendarSyncAdapter(transport,repo,states,{id:'pull-retry',googleCalendarId:'remote',localCalendarId:'personal',mode:'import'});

  await assert.rejects(()=>adapter.sync(),/simulated checkpoint failure/);
  assert.equal(repo.read().revision,1);
  assert.equal(repo.read().items[0].title,'Remote v2');

  const result=await adapter.sync();
  assert.equal(repo.read().revision,1);
  assert.equal(result.pulled,0);
  assert.equal(result.conflicts.length,0);
  assert.equal(result.state.syncToken,'token-2');
  assert.equal(result.state.links[0].identity.etag,'"e2"');
  assert.equal(result.state.links[0].baseLocalFingerprint,result.state.links[0].baseRemoteFingerprint);
});

test('Google import stages update delete and create into one guarded local commit',async()=>{
  const first=event({id:'e1',title:'One'});
  const second=event({id:'e2',title:'Two',start:'2026-03-02T14:00:00.000Z',end:'2026-03-02T15:00:00.000Z'});
  const remoteOne=Google.googleEventToCalendarItem({id:'g1',etag:'"b1"',summary:'One',start:{dateTime:first.start},end:{dateTime:first.end},reminders:{useDefault:false}},'personal','batch','e1','remote');
  const remoteTwo=Google.googleEventToCalendarItem({id:'g2',etag:'"b2"',summary:'Two',start:{dateTime:second.start},end:{dateTime:second.end},reminders:{useDefault:false}},'personal','batch','e2','remote');
  const states=new Sync.MemorySyncStateStore();
  states.write({
    provider:'google',connectionId:'batch',mode:'import',externalCalendarId:'remote',localCalendarId:'personal',syncToken:'token-1',
    links:[
      {localItemId:'e1',identity:{provider:'google',connectionId:'batch',externalCalendarId:'remote',eventId:'g1',etag:'"b1"'},baseLocalFingerprint:Sync.fingerprintCalendarItem(first),baseRemoteFingerprint:Sync.fingerprintCalendarItem(remoteOne),baseRemoteItem:remoteOne,status:'clean',lastSyncedAt:'2026-01-01T00:00:00Z'},
      {localItemId:'e2',identity:{provider:'google',connectionId:'batch',externalCalendarId:'remote',eventId:'g2',etag:'"b2"'},baseLocalFingerprint:Sync.fingerprintCalendarItem(second),baseRemoteFingerprint:Sync.fingerprintCalendarItem(remoteTwo),baseRemoteItem:remoteTwo,status:'clean',lastSyncedAt:'2026-01-01T00:00:00Z'},
    ],
  });

  const inner=new Core.MemoryCalendarRepository([source],[first,second]);
  let replacements=0,granularMutations=0;
  const repo={
    read:()=>inner.read(),
    create(){granularMutations++;throw Error('granular create must not be used');},
    update(){granularMutations++;throw Error('granular update must not be used');},
    remove(){granularMutations++;throw Error('granular remove must not be used');},
    replace(){throw Error('unguarded replace must not be used');},
    replaceAtRevision(items,revision){replacements++;inner.replaceAtRevision(items,revision);},
  };
  const transport={
    async listEvents(){return {items:[
      {id:'g1',etag:'"u1"',summary:'One updated',start:{dateTime:first.start},end:{dateTime:first.end},reminders:{useDefault:false}},
      {id:'g2',etag:'"d2"',status:'cancelled'},
      {id:'g3',etag:'"n3"',summary:'Three',start:{dateTime:'2026-03-03T14:00:00.000Z'},end:{dateTime:'2026-03-03T15:00:00.000Z'},reminders:{useDefault:false}},
    ],nextSyncToken:'token-2'};},
    async getEvent(){throw Error('unused');},async listInstances(){return {items:[]};},
    async insertEvent(){throw Error('unused');},async updateEvent(){throw Error('unused');},async patchEvent(){throw Error('unused');},async deleteEvent(){throw Error('unused');},
  };
  const adapter=new Google.GoogleCalendarSyncAdapter(transport,repo,states,{id:'batch',googleCalendarId:'remote',localCalendarId:'personal',mode:'import'});
  const result=await adapter.sync();

  assert.equal(replacements,1);
  assert.equal(granularMutations,0);
  assert.equal(inner.read().revision,1);
  assert.deepEqual(inner.read().items.map(item=>item.title).sort(),['One updated','Three']);
  assert.equal(result.pulled,2);
  assert.equal(result.deletedLocal,1);
});

test('Google incremental checkpoint refreshes provider identity without rewriting unchanged local data',async()=>{
  const local=event({title:'Stable'});
  const remoteBase=Google.googleEventToCalendarItem({id:'g1',etag:'"e1"',summary:'Stable',start:{dateTime:local.start},end:{dateTime:local.end},reminders:{useDefault:false}},'personal','identity-refresh','e1','remote');
  const states=new Sync.MemorySyncStateStore();
  states.write({
    provider:'google',connectionId:'identity-refresh',mode:'import',externalCalendarId:'remote',localCalendarId:'personal',syncToken:'token-1',
    links:[{localItemId:'e1',identity:{provider:'google',connectionId:'identity-refresh',externalCalendarId:'remote',eventId:'g1',etag:'"e1"'},baseLocalFingerprint:Sync.fingerprintCalendarItem(local),baseRemoteFingerprint:Sync.fingerprintCalendarItem(remoteBase),baseRemoteItem:remoteBase,status:'clean',lastSyncedAt:'2026-01-01T00:00:00Z'}],
  });
  const repo=new Core.MemoryCalendarRepository([source],[local]);
  const transport={
    async listEvents(){return {items:[{id:'g1',etag:'"e2"',sequence:2,summary:'Stable',start:{dateTime:local.start},end:{dateTime:local.end},reminders:{useDefault:false}}],nextSyncToken:'token-2'};},
    async getEvent(){throw Error('unused');},async listInstances(){return {items:[]};},
    async insertEvent(){throw Error('unused');},async updateEvent(){throw Error('unused');},async patchEvent(){throw Error('unused');},async deleteEvent(){throw Error('unused');},
  };
  const result=await new Google.GoogleCalendarSyncAdapter(transport,repo,states,{id:'identity-refresh',googleCalendarId:'remote',localCalendarId:'personal',mode:'import'}).sync();
  assert.equal(repo.read().revision,0);
  assert.equal(result.pulled,0);
  assert.equal(result.state.links[0].identity.etag,'"e2"');
  assert.equal(result.state.links[0].identity.sequence,2);
});

test('Google sync removes a stale link once both local and remote are already deleted',async()=>{
  const base=event({title:'Deleted'});
  const remoteBase=Google.googleEventToCalendarItem({id:'g1',etag:'"e1"',summary:'Deleted',start:{dateTime:base.start},end:{dateTime:base.end},reminders:{useDefault:false}},'personal','delete-rebase','e1','remote');
  const states=new Sync.MemorySyncStateStore();
  states.write({
    provider:'google',connectionId:'delete-rebase',mode:'import',externalCalendarId:'remote',localCalendarId:'personal',syncToken:'token-1',
    links:[{localItemId:'e1',identity:{provider:'google',connectionId:'delete-rebase',externalCalendarId:'remote',eventId:'g1',etag:'"e1"'},baseLocalFingerprint:Sync.fingerprintCalendarItem(base),baseRemoteFingerprint:Sync.fingerprintCalendarItem(remoteBase),baseRemoteItem:remoteBase,status:'clean',lastSyncedAt:'2026-01-01T00:00:00Z'}],
  });
  const repo=new Core.MemoryCalendarRepository([source],[]);
  const transport={
    async listEvents(){return {items:[{id:'g1',etag:'"e2"',status:'cancelled'}],nextSyncToken:'token-2'};},
    async getEvent(){throw Error('unused');},async listInstances(){return {items:[]};},
    async insertEvent(){throw Error('unused');},async updateEvent(){throw Error('unused');},async patchEvent(){throw Error('unused');},async deleteEvent(){throw Error('unused');},
  };
  const result=await new Google.GoogleCalendarSyncAdapter(transport,repo,states,{id:'delete-rebase',googleCalendarId:'remote',localCalendarId:'personal',mode:'import'}).sync();
  assert.equal(repo.read().revision,0);
  assert.deepEqual(result.state.links,[]);
  assert.equal(result.conflicts.length,0);
});
