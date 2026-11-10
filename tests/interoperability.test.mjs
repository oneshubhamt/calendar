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

test('failed reminder delivery remains retryable', async()=>{
  const repo=new Core.MemoryCalendarRepository([source],[event({start:'2026-01-02T10:00:00Z',end:'2026-01-02T11:00:00Z',reminders:[{id:'r',minutesBefore:60,channel:'in-app'}]})]);
  const receipts=new Reminder.MemoryReminderReceiptStore(); let calls=0;
  const coordinator=new Reminder.ReminderCoordinator({engine:new Core.CalendarEngine(repo),receipts,deliveries:[{channel:'in-app',deliver(){calls++;return calls>1;}}],timeZone:'UTC',lookBackMinutes:15});
  assert.equal((await coordinator.check(new Date('2026-01-02T09:00:00Z'))).length,0);
  assert.equal((await coordinator.check(new Date('2026-01-02T09:01:00Z'))).length,1); assert.equal(calls,2);
});
