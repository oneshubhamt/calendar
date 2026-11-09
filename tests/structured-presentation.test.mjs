import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { resolveOccurrencePresentation, resolveSourceActions } from '../dist/view/presentation.js';

function occurrence(overrides={}) {
  return {
    id:'source-1',sourceItemId:'source-1',occurrenceId:'source-1@2026-11-09T10:00:00Z',calendarId:'host',title:'Underlying title',
    start:'2026-11-09T10:00:00.000Z',end:'2026-11-09T11:30:00.000Z',originalStart:'2026-11-09T10:00:00.000Z',recurring:false,
    kind:'event',ownership:'host',editPolicy:'readonly',...overrides,
  };
}

test('structured presentation merges safe text slots, multiple badges and existing detail metadata',()=>{
  const row=occurrence();
  const extensions=[
    {presentOccurrence(){return {
      accessibleLabel:'TeamLab Planets, Ana at Toyosu, confirmed reservation',
      icon:{text:'✦',accessibleLabel:'Attraction'},
      leading:{text:'●',accessibleLabel:'Location marker'},
      title:'TeamLab <img src=x onerror=alert(1)>',
      subtitle:'Ana · Toyosu',
      trailing:'Reserved',
      badges:[{label:'Indoor'},{label:'Paid',accessibleLabel:'Payment complete'}],
      detailRows:[{label:'Host detail',value:'Authoritative'}],agendaMeta:'Tokyo',agendaOrder:2,
    };}},
    {presentOccurrence(){return {title:'TeamLab Planets',badges:[{label:'Confirmed'}],agendaOrder:-1};}},
  ];
  const result=resolveOccurrencePresentation(extensions,row);
  assert.equal(result.accessibleLabel,'TeamLab Planets, Ana at Toyosu, confirmed reservation');
  assert.equal(result.icon.text,'✦');
  assert.equal(result.icon.accessibleLabel,'Attraction');
  assert.equal(result.leading.text,'●');
  assert.equal(result.leading.accessibleLabel,'Location marker');
  assert.equal(result.title.text,'TeamLab Planets');
  assert.equal(result.subtitle.text,'Ana · Toyosu');
  assert.equal(result.trailing.text,'Reserved');
  assert.deepEqual(result.badges.map(b=>b.label),['Indoor','Paid','Confirmed']);
  assert.equal(result.badges[1].accessibleLabel,'Payment complete');
  assert.deepEqual(result.detailRows,[{label:'Host detail',value:'Authoritative'}]);
  assert.deepEqual(result.agendaMeta,['Tokyo']);
  assert.equal(result.agendaOrder,1);
});

test('presentation data keys fail closed instead of reaching DOMStringMap with malformed runtime names',()=>{
  const result=resolveOccurrencePresentation([{presentOccurrence(){return {data:{planningRole:'milestone','bad-key':'nope','also bad':'nope',ok:'yes',constructor:'nope',wrong:42}};}}],occurrence());
  assert.deepEqual(result.data,{planningRole:'milestone',ok:'yes'});
});

test('presentation content is preserved as text and the view has no HTML injection path',async()=>{
  const malicious='<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const result=resolveOccurrencePresentation([{presentOccurrence(){return {title:malicious,subtitle:malicious,badges:[{label:malicious}]};}}],occurrence());
  assert.equal(result.title.text,malicious);
  assert.equal(result.subtitle.text,malicious);
  assert.equal(result.badges[0].label,malicious);
  const view=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  assert.doesNotMatch(view,/innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(view,/function el<[\s\S]*node\.textContent = text/);
  assert.match(view,/dc-occurrence-title", presentation\.title\?\.text \?\? occurrence\.title/);
});

test('occurrence actions preserve old menu-only defaults and expose C4 state when opted inline',()=>{
  const port={
    actions(){return [
      {id:'open',label:'Open'},
      {id:'complete',label:'Complete',icon:'✓',inline:true,accessibleLabel:'Mark complete',state:'open',pressed:false,enabled:true,pending:false,primary:true,danger:false},
      {id:'paid',label:'Paid',inline:true,state:'paid',pressed:true,enabled:false,pending:false},
      {id:'sync',label:'Syncing',inline:true,enabled:true,pending:true},
    ];},
    execute(){},
  };
  const actions=resolveSourceActions(port,occurrence());
  assert.deepEqual(actions.map(a=>[a.id,a.inline,a.enabled,a.pending]),[
    ['open',false,true,false],['complete',true,true,false],['paid',true,false,false],['sync',true,true,true],
  ]);
  assert.equal(actions[1].accessibleLabel,'Mark complete');
  assert.equal(actions[1].icon,'✓');
  assert.equal(actions[1].danger,false);
  assert.equal(actions[1].state,'open');
  assert.equal(actions[1].pressed,false);
  assert.equal(actions[2].pressed,true);
});

test('malformed and duplicate action identities fail closed and provider failure cannot break Calendar rendering',()=>{
  const duplicate={actions(){return [
    {id:'same',label:'One',inline:true},{id:'same',label:'Two',inline:true},{id:'',label:'Missing ID',inline:true},{id:'bad-icon',label:'Bad icon',icon:42},{id:'bad-danger',label:'Bad danger',danger:'yes'},{id:'ok',label:'OK',inline:true},
  ];},execute(){}};
  assert.deepEqual(resolveSourceActions(duplicate,occurrence()).map(action=>action.id),['ok']);
  assert.deepEqual(resolveSourceActions({actions(){throw new Error('host unavailable');},execute(){}},occurrence()),[]);
});

test('inline actions are separate native controls and cannot open or start dragging the occurrence',async()=>{
  const view=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  assert.match(view,/const main = el\("button", "dc-occurrence-main dc-event-main"\)/);
  assert.match(view,/const main = el\("button", "dc-occurrence-main dc-time-event-main"\)/);
  assert.match(view,/const button = el\("button", className\)/);
  assert.match(view,/dc-action-icon/);
  assert.match(view,/dc-action-label/);
  assert.match(view,/button\.addEventListener\("pointerdown", event => event\.stopPropagation\(\)\)/);
  assert.match(view,/button\.addEventListener\("click", event => \{[\s\S]*event\.stopPropagation\(\)/);
  assert.match(view,/closest\("\.dc-resize-handle,\.dc-inline-action"\)/);
  assert.match(view,/closest\("\.dc-inline-action"\)/);
  assert.doesNotMatch(view,/el\("button", "dc-event"\)/);
});

test('inline action keyboard, pressed, disabled and pending accessibility are explicit',async()=>{
  const view=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  assert.match(view,/button\.setAttribute\("aria-label", action\.accessibleLabel \?\? action\.label\)/);
  assert.match(view,/if \(action\.primary\) button\.classList\.add\("dc-primary"\)/);
  assert.match(view,/if \(action\.danger\) button\.classList\.add\("dc-danger"\)/);
  assert.match(view,/button\.setAttribute\("aria-pressed", String\(action\.pressed\)\)/);
  assert.match(view,/button\.disabled = !action\.enabled \|\| pending/);
  assert.match(view,/button\.setAttribute\("aria-busy", "true"\)/);
  assert.match(view,/button\.addEventListener\("keydown", event => event\.stopPropagation\(\)\)/);
  assert.match(view,/bar\.setAttribute\("role", "group"\)/);
});


test('context-menu host actions reuse source action rendering without swallowing menu keyboard navigation',async()=>{
  const view=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  assert.match(view,/sourceActionButton\(action, occurrence, "dc-menu-item", \(\) => this\.dismissContextMenu\(\), false\)/);
  assert.match(view,/if \(isolateKeyboard\) button\.addEventListener\("keydown", event => event\.stopPropagation\(\)\)/);
  assert.match(view,/menu\.addEventListener\("keydown"/);
});

test('source action execution revalidates host state and reuses authoritative command lifecycle on success or failure',async()=>{
  const view=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  const execute=view.match(/private async executeSourceAction[\s\S]*?\n  }/)?.[0] ?? '';
  assert.match(execute,/commandLifecycle\.run\(authoritative\.occurrenceId/);
  assert.match(execute,/sourceActionsFor\(authoritative\)\.find\(action => action\.id === actionId\)/);
  assert.match(execute,/!current \|\| !current\.enabled \|\| current\.pending/);
  assert.match(execute,/await port\.execute\(actionId, authoritative\)/);
  assert.match(execute,/refresh: \(\) => this\.refresh\(\)/);
  assert.match(execute,/onError: error => this\.announce/);
  assert.match(view,/setOccurrencePending[\s\S]*\[data-action-id\][\s\S]*button\.disabled/);
});

test('C4 stays generic and introduces no host-domain semantics into generic view code',async()=>{
  const files=['../src/view/types.ts','../src/view/presentation.ts','../src/view/calendar-ui.ts'];
  const text=(await Promise.all(files.map(file=>fs.readFile(new URL(file,import.meta.url),'utf8')))).join('\n');
  for(const token of ['Ayana','journey','habit','payment','nominal']) assert.equal(new RegExp(`\\b${token}\\b`,'i').test(text),false,`generic C4 path leaked ${token}`);
  const declarations=await fs.readFile(new URL('../dist/view/types.d.ts',import.meta.url),'utf8');
  for(const field of ['icon','leading','title','subtitle','trailing','badges','inline','accessibleLabel','danger','state','pressed','enabled','pending']) assert.match(declarations,new RegExp(`readonly ${field}\\?`));
});
