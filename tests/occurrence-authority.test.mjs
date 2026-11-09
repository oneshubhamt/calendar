import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as C from '../dist/index.js';
import { baselineOccurrenceCapabilities, calendarOccurrenceCommandContext, resolveOccurrenceCapabilities, temporalMutationCapabilityRequirements } from '../dist/core/authority.js';
import { CalendarCommandLifecycle } from '../dist/view/command-lifecycle.js';
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

test('authority implementation helpers remain internal while the host capability contract stays public',async()=>{
  const declarations=await fs.readFile(new URL('../dist/core/types.d.ts',import.meta.url),'utf8');
  assert.match(declarations,/export interface CalendarOccurrenceCapabilityProvider/);
  assert.equal(C.resolveOccurrenceCapabilities,undefined);
  assert.equal(C.CalendarCommandLifecycle,undefined);
});

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
test('Calendar UI revalidates authority at execution and wires pending/error/refresh behavior without domain semantics',async()=>{
  const text=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  const editor=await fs.readFile(new URL('../src/view/event-editor.ts',import.meta.url),'utf8');
  assert.match(text,/dispatchOccurrence\([\s\S]*this\.occurrenceCapabilities\(occurrence\)/);
  assert.match(text,/commandPath === "trusted-host" \? this\.options\.trustedHostCommandHandler : this\.options\.commandHandler/);
  assert.match(text,/requirements\.some\(key => capabilities\[key\] !== true\)/);
  assert.match(text,/canResizeOccurrence\(occurrence, "start"\)/);
  assert.match(text,/canResizeOccurrence\(occurrence, "end"\)/);
  assert.match(text,/commandLifecycle\.run/);
  assert.match(text,/private isOccurrencePending\(occurrence: CalendarOccurrence\)/);
  assert.match(text,/aria-busy/);
  assert.match(text,/refresh: \(\) => this\.refresh\(\)/);
  assert.match(text,/is-command-preview/);
  assert.match(text,/occurrencePatchRequirements\(occurrence, patch\)/);
  assert.match(text,/pendingOperation\(occurrence\.occurrenceId\)/);
  assert.match(editor,/capabilities\.allowSemanticEdit \?\? baseSemanticEdit/);
  assert.match(editor,/capabilities\.allowAllDayConversion === false/);
  assert.match(text,/allowSemanticEdit: this\.canEditOccurrenceDetails\(occurrence, capabilities\)/);
  assert.match(text,/const fullEdit = this\.canEditOccurrenceDetails\(occurrence, capabilities\)/);
  assert.match(editor,/capabilities\.allowRecurrenceChange === false/);
  assert.match(editor,/capabilities\.allowStartChange === false/);
  assert.match(editor,/capabilities\.allowEndChange === false/);
  const canMove=text.match(/private canMoveOccurrence\([\s\S]*?\n  }/)?.[0] ?? '';
  assert.doesNotMatch(canMove,/isPending|commandLifecycle/);
  for(const token of ['Ayana','nominal','journey','habit','payment']) assert.equal(new RegExp(`\\b${token}\\b`,'i').test(text),false,`generic authority path leaked ${token}`);
});
