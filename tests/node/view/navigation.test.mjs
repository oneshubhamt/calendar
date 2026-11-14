import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundProjectionRange,
  clampNavigationDate,
  navigationDateInBounds,
  resolveNavigationBounds,
} from '../../../dist/view/navigation.js';
import { placementInNavigationBounds } from '../../../dist/core/interaction.js';

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
