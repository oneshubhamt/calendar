import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  boundProjectionRange,
  clampNavigationDate,
  navigationDateInBounds,
  resolveNavigationBounds,
} from '../dist/view/navigation.js';
import { placementInNavigationBounds } from '../dist/core/interaction.js';

const zone='Asia/Kolkata';

test('one-day navigation bounds are inclusive and clamp programmatic anchors',()=>{
  const bounds=resolveNavigationBounds({min:'2026-04-14',max:'2026-04-14'});
  assert.equal(navigationDateInBounds('2026-04-14T12:00:00+05:30',bounds,zone),true);
  assert.equal(navigationDateInBounds('2026-04-13T23:59:00+05:30',bounds,zone),false);
  assert.equal(navigationDateInBounds('2026-04-15T00:00:00+05:30',bounds,zone),false);
  assert.equal(clampNavigationDate('2026-04-01T12:00:00+05:30',bounds,zone).toISOString(),'2026-04-13T18:30:00.000Z');
  assert.equal(clampNavigationDate('2026-04-30T12:00:00+05:30',bounds,zone).toISOString(),'2026-04-13T18:30:00.000Z');
});

test('navigation bounds fail closed when malformed or reversed',()=>{
  assert.throws(()=>resolveNavigationBounds({min:'2026-02-30'}),/invalid/i);
  assert.throws(()=>resolveNavigationBounds({max:'14-04-2026'}),/invalid ISO date/i);
  assert.throws(()=>resolveNavigationBounds({min:'2026-04-15',max:'2026-04-14'}),/minimum date must not be after maximum date/i);
});

test('projection queries are intersected with navigation bounds without changing host-visible view geometry',()=>{
  const bounds=resolveNavigationBounds({min:'2026-04-14',max:'2026-04-16'});
  assert.deepEqual(boundProjectionRange({start:'2026-04-12T18:30:00.000Z',end:'2026-04-19T18:30:00.000Z'},bounds,zone),{
    start:'2026-04-13T18:30:00.000Z',
    end:'2026-04-16T18:30:00.000Z',
  });
});

test('placement bounds allow the complete maximum day but reject cross-boundary drag or resize',()=>{
  const bounds=resolveNavigationBounds({min:'2026-04-14',max:'2026-04-16'});
  const d=value=>new Date(value);
  assert.equal(placementInNavigationBounds(d('2026-04-13T18:30:00.000Z'),d('2026-04-13T19:30:00.000Z'),bounds,zone),true);
  assert.equal(placementInNavigationBounds(d('2026-04-16T17:30:00.000Z'),d('2026-04-16T18:30:00.000Z'),bounds,zone),true);
  assert.equal(placementInNavigationBounds(d('2026-04-16T18:00:00.000Z'),d('2026-04-16T19:00:00.000Z'),bounds,zone),false);
  assert.equal(placementInNavigationBounds(d('2026-04-13T18:29:59.000Z'),d('2026-04-13T19:00:00.000Z'),bounds,zone),false);
  assert.equal(placementInNavigationBounds(d('2026-04-16T18:29:59.000Z'),d('2026-04-16T18:29:59.000Z'),bounds,zone),true,'point on maximum date remains valid');
  assert.equal(placementInNavigationBounds(d('2026-04-16T18:30:00.000Z'),d('2026-04-16T18:30:00.000Z'),bounds,zone),false,'max is an inclusive local date, not the next midnight');
});

test('embedded chrome is granular and toolbar removal does not make rendering depend on a title node',async()=>{
  const types=await fs.readFile(new URL('../src/view/types.ts',import.meta.url),'utf8');
  const view=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  for(const key of ['toolbar','dateNavigation','viewSwitcher','sourceControls','createControls']) assert.match(types,new RegExp(`readonly ${key}\\?: boolean`));
  assert.match(view,/if \(this\.chrome\.toolbar\) root\.append\(this\.toolbar\(\)\)/);
  assert.match(view,/if \(!root \|\| !body\) return;\s*if \(title\) title\.textContent/);
  assert.match(view,/if \(this\.chrome\.dateNavigation\)/);
  assert.match(view,/if \(this\.chrome\.sourceControls\)/);
  assert.match(view,/if \(this\.chrome\.viewSwitcher\)/);
  assert.match(view,/this\.chrome\.createControls && this\.canCreateItems\(\)/);
});

test('hidden toolbar does not disable keyboard date navigation and programmatic navigation is clamped',async()=>{
  const view=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  assert.match(view,/public goTo[\s\S]*this\.anchor = clampNavigationDate\(value, this\.navigationBounds, this\.timeZone\)/);
  assert.match(view,/else if \(event\.key === "ArrowLeft"\) \{ event\.preventDefault\(\); this\.previous\(\); \}/);
  assert.match(view,/else if \(event\.key === "ArrowRight"\) \{ event\.preventDefault\(\); this\.next\(\); \}/);
  assert.doesNotMatch(view,/chrome\.toolbar[\s\S]{0,100}ArrowLeft/);
});

test('jump, drag, creation and add-on placement share the same bounded enforcement path',async()=>{
  const view=await fs.readFile(new URL('../src/view/calendar-ui.ts',import.meta.url),'utf8');
  const dialogs=await fs.readFile(new URL('../src/view/dialogs.ts',import.meta.url),'utf8');
  assert.match(view,/requestCalendarDate\([^\n]*this\.navigationBounds\)/);
  assert.match(dialogs,/if \(bounds\?\.min\) input\.min = bounds\.min/);
  assert.match(dialogs,/if \(bounds\?\.max\) input\.max = bounds\.max/);
  assert.match(view,/private async allowPlacement[\s\S]*evaluateCalendarPlacement\(context/);
  assert.match(view,/private async allowPlacement[\s\S]*const queryRange = boundProjectionRange\(/);
  assert.match(view,/if \(!inBounds \|\| !occurrence \|\| !this\.canMoveOccurrenceToPlacement\(occurrence, false\)\) return/);
  assert.match(view,/canPlaceDraft:[\s\S]*self\.allowPlacement/);
  assert.match(view,/patchOccurrence:[\s\S]*self\.allowPlacement/);
});

test('C5 generic view contract contains no host-domain semantic dependency',async()=>{
  const files=['../src/view/types.ts','../src/view/navigation.ts','../src/view/calendar-ui.ts','../src/view/dialogs.ts'];
  const text=(await Promise.all(files.map(file=>fs.readFile(new URL(file,import.meta.url),'utf8')))).join('\n');
  for(const token of ['Ayana','journey','habit','payment','nominal']) assert.equal(new RegExp(`\\b${token}\\b`,'i').test(text),false,`generic C5 path leaked ${token}`);
});
