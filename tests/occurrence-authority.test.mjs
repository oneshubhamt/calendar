import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../dist/index.js';
import { baselineOccurrenceCapabilities, calendarOccurrenceCommandContext, resolveOccurrenceCapabilities, temporalMutationCapabilityRequirements } from '../dist/core/authority.js';
import { CalendarCommandLifecycle } from '../dist/view/command-lifecycle.js';
import { occurrenceWithPreview } from '../dist/view/occurrence-preview.js';
import { CalendarMutationCoordinator } from '../dist/view/mutation-coordinator.js';
import { CalendarCommandStaleError } from '../dist/core/commands.js';

const source={id:'host',title:'Host',visible:true};
const readOnlySource={...source,readOnly:true};

function occurrence(overrides={}) {
  return {
    id:'source-1',sourceItemId:'source-1',occurrenceId:'source-1@2026-11-09T10:00:00Z',calendarId:'host',title:'Projected occurrence',
    start:'2026-11-09T10:00:00.000Z',end:'2026-11-09T11:00:00.000Z',originalStart:'2026-11-09T10:00:00.000Z',recurring:true,
    kind:'event',ownership:'host',editPolicy:'full',projectionIdentity:{series:'opaque',slot:4},...overrides,
  };
}

test('baseline per-occurrence authority preserves existing full, schedule-only and readonly behavior',()=>{
  const full=baselineOccurrenceCapabilities(occurrence(),source);
  assert.equal(full.canMove,true);
  assert.equal(full.canResizeStart,true);
  assert.equal(full.canResizeEnd,true);
  assert.equal(full.canEdit,true);
  assert.equal(full.canDelete,true);
  assert.equal(full.canChangeRecurrence,true);

  const schedule=baselineOccurrenceCapabilities(occurrence({editPolicy:'schedule-only'}),source);
  assert.equal(schedule.canMove,true);
  assert.equal(schedule.canEdit,false);
  assert.equal(schedule.canChangeRecurrence,false);

  const readonly=baselineOccurrenceCapabilities(occurrence({editPolicy:'readonly'}),source);
  assert.equal(readonly.canMove,false);
  assert.equal(readonly.canEdit,false);
  assert.equal(readonly.canDelete,false);
  assert.equal(readonly.canOpen,true);

  const generated=baselineOccurrenceCapabilities(occurrence({editPolicy:'generated'}),source);
  assert.equal(generated.canResizeEnd,false);
  assert.equal(baselineOccurrenceCapabilities(occurrence(),readOnlySource).canMove,false);
});

test('default capability providers can narrow authority but cannot widen Calendar policy',()=>{
  const full=occurrence();
  const narrowed=resolveOccurrenceCapabilities(full,source,{capabilities(){return {canMove:false,canEdit:true};}});
  assert.equal(narrowed.canMove,false);
  assert.equal(narrowed.canEdit,true);
  assert.equal(narrowed.commandPath,'default');

  const readonly=occurrence({editPolicy:'readonly'});
  const attemptedWiden=resolveOccurrenceCapabilities(readonly,readOnlySource,{capabilities(){return {canMove:true,canEdit:true,canDelete:true};}});
  assert.equal(attemptedWiden.canMove,false);
  assert.equal(attemptedWiden.canEdit,false);
  assert.equal(attemptedWiden.canDelete,false);
});

test('trusted-host authority may explicitly grant selected operations and supports asymmetric capabilities',()=>{
  const readonly=occurrence({editPolicy:'readonly'});
  const resolved=resolveOccurrenceCapabilities(readonly,readOnlySource,{capabilities(){return {
    commandPath:'trusted-host',canMove:true,canResizeStart:false,canResizeEnd:true,canEdit:false,canDelete:true,canMoveBetweenAllDayAndTimed:false,
  };}});
  assert.equal(resolved.commandPath,'trusted-host');
  assert.equal(resolved.canMove,true);
  assert.equal(resolved.canResizeStart,false);
  assert.equal(resolved.canResizeEnd,true);
  assert.equal(resolved.canEdit,false);
  assert.equal(resolved.canDelete,true);
  assert.equal(resolved.canMoveBetweenAllDayAndTimed,false);
  assert.equal(resolved.canChangeRecurrence,false);

  const editableNotMovable=resolveOccurrenceCapabilities(readonly,readOnlySource,{capabilities(){return {commandPath:'trusted-host',canEdit:true,canMove:false};}});
  assert.equal(editableNotMovable.canEdit,true);
  assert.equal(editableNotMovable.canMove,false);
});

test('capability providers are dynamic so execution-time revalidation can observe revoked authority',()=>{
  let movable=true;
  const provider={capabilities(){return {canMove:movable};}};
  assert.equal(resolveOccurrenceCapabilities(occurrence(),source,provider).canMove,true);
  movable=false;
  assert.equal(resolveOccurrenceCapabilities(occurrence(),source,provider).canMove,false);
});

test('capability provider failure fails closed instead of crashing or falling back to writable authority',()=>{
  const resolved=resolveOccurrenceCapabilities(occurrence(),source,{capabilities(){throw new Error('host failed');}});
  assert.equal(resolved.canOpen,false);
  assert.equal(resolved.canMove,false);
  assert.equal(resolved.canEdit,false);
  assert.equal(resolved.canDelete,false);
  assert.equal(resolved.canInvokeActions,false);
});

test('malformed runtime capability values fail closed for the affected operation',()=>{
  const resolved=resolveOccurrenceCapabilities(occurrence(),source,{capabilities(){return {canMove:'yes',canDelete:1,canEdit:true};}});
  assert.equal(resolved.canMove,false);
  assert.equal(resolved.canDelete,false);
  assert.equal(resolved.canEdit,true);
});

test('occurrence command context preserves stable source, occurrence, opaque identity and series scope',()=>{
  const row=occurrence();
  const command={type:'move-occurrence',occurrence:row,start:'2026-11-09T12:00:00.000Z',end:'2026-11-09T13:00:00.000Z',scope:'this-and-following'};
  const context=calendarOccurrenceCommandContext(command,'2026-11-09T09:00:00.000Z','Asia/Kolkata');
  assert.equal(context.occurrenceId,row.occurrenceId);
  assert.equal(context.sourceItemId,row.sourceItemId);
  assert.strictEqual(context.projectionIdentity,row.projectionIdentity);
  assert.equal(context.seriesScope,'this-and-following');
  assert.equal(context.timeZone,'Asia/Kolkata');
});

test('command lifecycle tracks operation-specific pending state while suppressing concurrent commands for one occurrence',async()=>{
  const lifecycle=new CalendarCommandLifecycle();
  const transitions=[];
  let release;
  const blocker=new Promise(resolve=>{release=resolve;});
  let refreshes=0;
  const first=lifecycle.run('occ-1','move',async()=>{await blocker;},{onPendingChange:(group,operation,pending)=>transitions.push([group,operation,pending]),refresh:()=>{refreshes++;}});
  await Promise.resolve();
  assert.equal(lifecycle.isPending('occ-1'),true);
  assert.equal(lifecycle.isPending('occ-1','move'),true);
  assert.equal(lifecycle.pendingOperation('occ-1'),'move');
  const duplicate=await lifecycle.run('occ-1','resize-end',()=>{throw new Error('must not run');});
  assert.equal(duplicate,'suppressed');
  release();
  assert.equal(await first,'completed');
  assert.equal(lifecycle.isPending('occ-1'),false);
  assert.equal(lifecycle.pendingOperation('occ-1'),undefined);
  assert.deepEqual(transitions,[['occ-1','move',true],['occ-1','move',false]]);
  assert.equal(refreshes,1);
});

test('rejected or stale host commands refresh authoritative state, surface the error and clear pending state',async()=>{
  const lifecycle=new CalendarCommandLifecycle();
  let refreshes=0;
  const errors=[];
  const result=await lifecycle.run('occ-stale','edit',async()=>{throw new CalendarCommandStaleError('stale host revision');},{refresh:()=>{refreshes++;},onError:error=>errors.push([error.code,error.message])});
  assert.equal(result,'rejected');
  assert.equal(refreshes,1);
  assert.deepEqual(errors,[['stale','stale host revision']]);
  assert.equal(lifecycle.isPending('occ-stale'),false);
});

test('temporal patch authority distinguishes move from independent edge changes and all-day conversion',()=>{
  assert.deepEqual(temporalMutationCapabilityRequirements({beforeStart:100,beforeEnd:200,afterStart:150,afterEnd:250}),['canMove']);
  assert.deepEqual(temporalMutationCapabilityRequirements({beforeStart:100,beforeEnd:200,afterStart:150,afterEnd:200}),['canResizeStart']);
  assert.deepEqual(temporalMutationCapabilityRequirements({beforeStart:100,beforeEnd:200,afterStart:100,afterEnd:250}),['canResizeEnd']);
  assert.deepEqual(temporalMutationCapabilityRequirements({beforeStart:100,beforeEnd:200,afterStart:150,afterEnd:260}),['canResizeStart','canResizeEnd']);
  assert.deepEqual(temporalMutationCapabilityRequirements({beforeStart:100,beforeEnd:200,afterStart:100,afterEnd:200,crossesAllDayBoundary:true}),['canMove','canMoveBetweenAllDayAndTimed']);
});


test('command lifecycle distinguishes rejected mutation from committed refresh failure',async()=>{
  const lifecycle=new CalendarCommandLifecycle();
  const rejected=await lifecycle.run('reject','move',()=>{throw new Error('reject');},{refresh(){}});
  assert.equal(rejected,'rejected');

  let committed=false;
  const refreshFailed=await lifecycle.run('refresh-failure','move',()=>{committed=true;},{
    refresh(){throw new Error('offline');},
  });
  assert.equal(committed,true);
  assert.equal(refreshFailed,'committed-refresh-failed');
});

test('command lifecycle notification hooks cannot corrupt authoritative completion status',async()=>{
  const lifecycle=new CalendarCommandLifecycle();
  const pendingFailure=await lifecycle.run('hook-completed','move',()=>{},{
    onPendingChange(){throw new Error('pending UI failed');},
  });
  assert.equal(pendingFailure,'completed');
  assert.equal(lifecycle.isPending('hook-completed'),false);

  const rejected=await lifecycle.run('hook-rejected','edit',()=>{throw new Error('write rejected');},{
    onError(){throw new Error('announcement failed');},
  });
  assert.equal(rejected,'rejected');
  assert.equal(lifecycle.isPending('hook-rejected'),false);

  const refreshFailed=await lifecycle.run('hook-refresh','move',()=>{},{
    refresh(){throw new Error('projection offline');},
    onRefreshError(){throw new Error('announcement failed');},
  });
  assert.equal(refreshFailed,'committed-refresh-failed');
  assert.equal(lifecycle.isPending('hook-refresh'),false);
});

test('tentative occurrence geometry can be reconstructed after authoritative re-render',()=>{
  const row=occurrence();
  const preview={patch:{start:'2026-11-09T12:00:00.000Z',end:'2026-11-09T13:00:00.000Z'}};
  const first=occurrenceWithPreview(row,preview,'UTC');
  const refreshed=occurrenceWithPreview({...row,title:'Fresh authoritative title'},preview,'UTC');
  assert.equal(first.start,'2026-11-09T12:00:00.000Z');
  assert.equal(refreshed.start,'2026-11-09T12:00:00.000Z');
  assert.equal(refreshed.title,'Fresh authoritative title');
  assert.equal(row.start,'2026-11-09T10:00:00.000Z');
});


test('mutation coordinator revalidates occurrence authority and owns pending preview lifecycle',async()=>{
  const row=occurrence({occurrenceId:'coordinated',sourceItemId:'source-1'});
  let current=row;
  let release;
  const blocker=new Promise(resolve=>{release=resolve;});
  const transitions=[];
  const commands=[];
  let refreshes=0;
  const coordinator=new CalendarMutationCoordinator({
    engine:new C.CalendarEngine(new C.MemoryCalendarRepository([source],[])),
    clock:{now:()=>new Date('2026-11-09T09:00:00.000Z')},
    timeZone:'UTC',
    navigationBounds:{},
    collisionPolicy:{mode:'allow',includeAllDay:false},
    placementGuards:undefined,
    commandHandler:{async execute(command){commands.push(command);await blocker;}},
    trustedHostCommandHandler:undefined,
    occurrenceCapabilities:undefined,
    sourceActions:undefined,
    sources:()=>[source],
    occurrence:id=>id===current.occurrenceId?current:undefined,
    refresh:async()=>{refreshes+=1;},
    announce:()=>{},
    onCommand:()=>{},
    onPendingChange:(id,operation,pending)=>transitions.push([id,operation,pending]),
    onSettled:()=>{},
    confirmPlacementWarning:async()=>true,
    selectSeriesScope:async()=> 'all',
  });

  const stableOccurrences=[row];
  assert.strictEqual(coordinator.previewOccurrences(stableOccurrences),stableOccurrences);

  const command={
    type:'move-occurrence',
    occurrence:row,
    start:'2026-11-09T12:00:00.000Z',
    end:'2026-11-09T13:00:00.000Z',
    scope:'this',
  };
  const pending=coordinator.dispatchOccurrence(command,['canMove'],'move');
  await Promise.resolve();
  assert.equal(coordinator.isPending(row),true);
  const previewed=coordinator.previewOccurrences(stableOccurrences);
  assert.notStrictEqual(previewed,stableOccurrences);
  assert.equal(previewed[0].start,'2026-11-09T12:00:00.000Z');
  assert.equal(coordinator.previewOccurrence(row).start,'2026-11-09T12:00:00.000Z');
  release();
  assert.equal(await pending,'completed');
  assert.equal(coordinator.isPending(row),false);
  assert.equal(coordinator.previewOccurrence(row).start,row.start);
  assert.equal(commands.length,1);
  assert.equal(refreshes,1);
  assert.deepEqual(transitions,[
    ['coordinated','move',true],
    ['coordinated','move',false],
  ]);

  current={...row,editPolicy:'readonly'};
  const denied=await coordinator.dispatchOccurrence(command,['canMove'],'move');
  assert.equal(denied,'rejected');
  assert.equal(commands.length,1);
});

test('mutation coordinator executes occurrence commands with the latest authoritative occurrence payload and context',async()=>{
  const rendered=occurrence();
  const authoritative={
    ...rendered,
    start:'2026-11-09T11:00:00.000Z',
    end:'2026-11-09T12:00:00.000Z',
    projectionIdentity:{series:'opaque',slot:4,version:2},
  };
  const executed=[];
  const observed=[];
  const coordinator=new CalendarMutationCoordinator({
    engine:new C.CalendarEngine(new C.MemoryCalendarRepository([source],[])),
    clock:{now:()=>new Date('2026-11-09T09:00:00.000Z')},
    timeZone:'UTC',
    navigationBounds:{},
    collisionPolicy:{mode:'allow',includeAllDay:false},
    placementGuards:undefined,
    commandHandler:{execute(command,context){executed.push([command,context]);}},
    trustedHostCommandHandler:undefined,
    occurrenceCapabilities:undefined,
    sourceActions:undefined,
    sources:()=>[source],
    occurrence:id=>id===authoritative.occurrenceId?authoritative:undefined,
    refresh:async()=>{},
    announce:()=>{},
    onCommand:command=>observed.push(command),
    onPendingChange:()=>{},
    onSettled:()=>{},
    confirmPlacementWarning:async()=>true,
    selectSeriesScope:async()=> 'all',
  });
  const command={
    type:'move-occurrence',
    occurrence:rendered,
    start:'2026-11-09T12:00:00.000Z',
    end:'2026-11-09T13:00:00.000Z',
    scope:'this',
  };

  assert.equal(await coordinator.dispatchOccurrence(command,['canMove'],'move'),'completed');
  assert.equal(executed.length,1);
  assert.strictEqual(executed[0][0].occurrence,authoritative);
  assert.strictEqual(executed[0][1].occurrence,authoritative);
  assert.strictEqual(executed[0][1].projectionIdentity,authoritative.projectionIdentity);
  assert.strictEqual(observed[0].occurrence,authoritative);
  assert.strictEqual(command.occurrence,rendered);
});

test('ordinary mutations distinguish rejection from committed refresh failure',async()=>{
  const announcements=[];
  let commits=0;
  const coordinator=new CalendarMutationCoordinator({
    engine:new C.CalendarEngine(new C.MemoryCalendarRepository([source],[])),
    clock:{now:()=>new Date('2026-11-09T09:00:00.000Z')},
    timeZone:'UTC',
    navigationBounds:{},
    collisionPolicy:{mode:'allow',includeAllDay:false},
    placementGuards:undefined,
    commandHandler:{execute(){commits+=1;}},
    trustedHostCommandHandler:undefined,
    occurrenceCapabilities:undefined,
    sourceActions:undefined,
    sources:()=>[source],
    occurrence:()=>undefined,
    refresh:async()=>{throw new Error('projection offline');},
    announce:message=>announcements.push(message),
    onCommand:()=>{},
    onPendingChange:()=>{},
    onSettled:()=>{},
    confirmPlacementWarning:async()=>true,
    selectSeriesScope:async()=> 'all',
  });
  const item={
    id:'new-item',calendarId:'host',title:'New item',start:'2026-11-09T10:00:00.000Z',end:'2026-11-09T11:00:00.000Z',
    kind:'event',ownership:'host',editPolicy:'full',
  };

  assert.equal(await coordinator.dispatch({type:'create',item}),'committed-refresh-failed');
  assert.equal(commits,1);
  assert.match(announcements.at(-1),/committed, but the authoritative refresh failed/);

  const rejected=new CalendarMutationCoordinator({
    engine:new C.CalendarEngine(new C.MemoryCalendarRepository([source],[])),
    clock:{now:()=>new Date('2026-11-09T09:00:00.000Z')},
    timeZone:'UTC',
    navigationBounds:{},
    collisionPolicy:{mode:'allow',includeAllDay:false},
    placementGuards:undefined,
    commandHandler:{execute(){throw new Error('write rejected');}},
    trustedHostCommandHandler:undefined,
    occurrenceCapabilities:undefined,
    sourceActions:undefined,
    sources:()=>[source],
    occurrence:()=>undefined,
    refresh:async()=>{},
    announce:message=>announcements.push(message),
    onCommand:()=>{},
    onPendingChange:()=>{},
    onSettled:()=>{},
    confirmPlacementWarning:async()=>true,
    selectSeriesScope:async()=> 'all',
  });
  assert.equal(await rejected.dispatch({type:'create',item:{...item,id:'rejected-item'}}),'rejected');
  assert.equal(announcements.at(-1),'write rejected');
});

test('undo and redo use canonical mutation lifecycle without turning refresh failure into a false rejection',async()=>{
  const announcements=[];
  let refreshFails=true;
  let undos=0;
  let redos=0;
  const coordinator=new CalendarMutationCoordinator({
    engine:new C.CalendarEngine(new C.MemoryCalendarRepository([source],[])),
    clock:{now:()=>new Date('2026-11-09T09:00:00.000Z')},
    timeZone:'UTC',
    navigationBounds:{},
    collisionPolicy:{mode:'allow',includeAllDay:false},
    placementGuards:undefined,
    commandHandler:{
      execute(){},
      undo(){undos+=1;return true;},
      redo(){redos+=1;return true;},
    },
    trustedHostCommandHandler:undefined,
    occurrenceCapabilities:undefined,
    sourceActions:undefined,
    sources:()=>[source],
    occurrence:()=>undefined,
    refresh:async()=>{if(refreshFails) throw new Error('projection offline');},
    announce:message=>announcements.push(message),
    onCommand:()=>{},
    onPendingChange:()=>{},
    onSettled:()=>{},
    confirmPlacementWarning:async()=>true,
    selectSeriesScope:async()=> 'all',
  });

  assert.equal(await coordinator.undo(),'committed-refresh-failed');
  assert.equal(undos,1);
  assert.match(announcements.at(-1),/undo was committed, but the authoritative refresh failed/);

  refreshFails=false;
  assert.equal(await coordinator.redo(),'completed');
  assert.equal(redos,1);
  assert.equal(announcements.at(-1),'Calendar change redone.');

  const noHistory=new CalendarMutationCoordinator({
    engine:new C.CalendarEngine(new C.MemoryCalendarRepository([source],[])),
    clock:{now:()=>new Date('2026-11-09T09:00:00.000Z')},
    timeZone:'UTC',
    navigationBounds:{},
    collisionPolicy:{mode:'allow',includeAllDay:false},
    placementGuards:undefined,
    commandHandler:{execute(){},undo(){return false;}},
    trustedHostCommandHandler:undefined,
    occurrenceCapabilities:undefined,
    sourceActions:undefined,
    sources:()=>[source],
    occurrence:()=>undefined,
    refresh:async()=>{throw new Error('must not refresh');},
    announce:()=>{},
    onCommand:()=>{},
    onPendingChange:()=>{},
    onSettled:()=>{},
    confirmPlacementWarning:async()=>true,
    selectSeriesScope:async()=> 'all',
  });
  assert.equal(await noHistory.undo(),'cancelled');
});

