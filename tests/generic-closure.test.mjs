import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as Calendar from '../dist/index.js';

const read = path => fs.readFile(new URL(path, import.meta.url), 'utf8');

test('C11 generic core/view remains free of host-domain semantics', async () => {
  const files = [
    '../src/core/types.ts','../src/core/authority.ts','../src/core/calendar-engine.ts','../src/core/commands.ts',
    '../src/core/layout.ts','../src/core/recurrence.ts','../src/core/store.ts',
    '../src/view/types.ts','../src/view/calendar-ui.ts','../src/view/event-editor.ts','../src/view/presentation.ts',
    '../src/view/command-lifecycle.ts','../src/view/navigation.ts','../src/view/time-zone-scale.ts',
  ];
  const text = (await Promise.all(files.map(read))).join('\n');
  for (const token of ['Ayana','journey','intent','habit','payment','nominal']) {
    assert.equal(new RegExp(`\\b${token}\\b`, 'i').test(text), false, `generic source leaked ${token}`);
  }
});

test('C11 keeps item and occurrence projection paths structurally separate', async () => {
  const engine = await read('../src/core/calendar-engine.ts');
  const itemProjection = engine.indexOf('provider.project(range)');
  const expansion = engine.indexOf('expandItems(');
  const occurrenceProjection = engine.indexOf('provider.projectOccurrences(range)');
  assert.ok(itemProjection >= 0 && expansion > itemProjection && occurrenceProjection > expansion);
  assert.match(engine, /assertCalendarOccurrenceIntegrity\(snapshot\.sources, projectedOccurrences\)/);
  assert.doesNotMatch(engine.slice(occurrenceProjection), /expandItems\(.*projectedOccurrences/s);
});

test('C11 authority paths converge on capability resolution and temporal mutation classification', async () => {
  const view = await read('../src/view/calendar-ui.ts');
  const editor = await read('../src/view/event-editor.ts');
  assert.match(view, /occurrencePatchRequirements\(occurrence, patch\)/);
  assert.match(view, /temporalMutationCapabilityRequirements/);
  assert.match(view, /requirements\.some\(key => capabilities\[key\] !== true\)/);
  assert.match(view, /allowSemanticEdit: this\.canEditOccurrenceDetails\(occurrence, capabilities\)/);
  assert.match(view, /const fullEdit = this\.canEditOccurrenceDetails\(occurrence, capabilities\)/);
  assert.match(editor, /capabilities\.allowSemanticEdit \?\? baseSemanticEdit/);
});

test('C11 keeps internal implementation helpers out of the root package API', () => {
  for (const name of ['resolveOccurrenceCapabilities','CalendarCommandLifecycle','resolveOccurrencePresentation','secondaryTimeScaleLabels','resolveNavigationBounds']) {
    assert.equal(Calendar[name], undefined, `${name} should remain internal`);
  }
});

test('C11 programme documentation uses the authoritative C1 through C11 sequence', async () => {
  const programme = await read('../docs/AYANA_IMPLEMENTATION_PROGRAMME.md');
  const headings = [...programme.matchAll(/^## Phase C(\d+) —/gm)].map(match => Number(match[1]));
  assert.deepEqual(headings, [1,2,3,4,5,6,7,8,9,10,11]);
});
