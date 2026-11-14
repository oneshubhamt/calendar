import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../../dist/index.js';
import { makeCalendarItem, makePersonalSource } from '../../fixtures/domain.mjs';

const source=makePersonalSource({removable:true});
const event=(patch={})=>makeCalendarItem(patch);

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

test('revision-guarded repository transitions match an independent state model and never partially apply a stale proposal', () => {
  const source = makePersonalSource();
  const item = makeCalendarItem({ id: 'cas-item' });
  const repo = new C.MemoryCalendarRepository([source], [item]);
  const model = { revision: 0, title: item.title };
  const actions = [
    { expectedRevision: 0, title: 'First', accepted: true },
    { expectedRevision: 0, title: 'Stale previous', accepted: false },
    { expectedRevision: 1, title: 'Second', accepted: true },
    { expectedRevision: 3, title: 'Future', accepted: false },
    { expectedRevision: 2, title: 'Third', accepted: true },
    { expectedRevision: 1, title: 'Older', accepted: false },
  ];
  for (const { expectedRevision, title, accepted } of actions) {
    const attempted = [{ ...item, title }];
    if (accepted) {
      repo.replaceAtRevision(attempted, expectedRevision);
      model.revision += 1;
      model.title = title;
    } else {
      assert.throws(
        () => repo.replaceAtRevision(attempted, expectedRevision),
        error => error instanceof C.CalendarStaleRevisionError && error.code === 'stale'
          && error.expectedRevision === expectedRevision && error.actualRevision === model.revision,
        `stale expected revision ${expectedRevision} must not commit`,
      );
    }
    const snapshot = repo.read();
    assert.equal(snapshot.revision, model.revision);
    assert.deepEqual(snapshot.items.map(({ id, title }) => ({ id, title })), [{ id: item.id, title: model.title }]);
  }
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
