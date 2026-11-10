import test from 'node:test';
import assert from 'node:assert/strict';
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
