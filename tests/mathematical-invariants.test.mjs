import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  dateKey,
  intervalsOverlap,
  layoutTimedDay,
  placementCollisions,
  snapMinuteCoordinate,
  toDate,
} from "../dist/index.js";
import { instantToPlain } from "../dist/core/temporal.js";
import {
  expandTemporalSeries,
  temporalSeriesIdentityAtOrdinal,
  temporalSeriesOrdinal,
} from "../dist/core/recurrence.js";
import {
  associateCalendarResources,
  validateCalendarResourceAssignments,
} from "../dist/features/resource-scheduler/index.js";
import * as Sync from "../dist/interoperability/sync.js";
import { makeCalendarItem, makeResourceOccurrence } from "./fixtures/domain.mjs";

const DAY_MS = 86_400_000;

function utcDateKey(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function permutations(values) {
  if (values.length <= 1) return [values.slice()];
  const output = [];
  for (let index = 0; index < values.length; index += 1) {
    const head = values[index];
    const tail = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const rest of permutations(tail)) output.push([head, ...rest]);
  }
  return output;
}

function layoutSignature(rows) {
  return [...rows]
    .sort((a, b) => a.occurrence.occurrenceId.localeCompare(b.occurrence.occurrenceId))
    .map(row => [
      row.occurrence.occurrenceId,
      row.topMinutes,
      row.heightMinutes,
      row.column,
      row.columnCount,
      row.columnSpan,
      row.temporalForm,
      row.visualLane,
      row.visualLaneCount,
    ]);
}

function temporalOverlap(left, right) {
  const leftStart = Date.parse(left.start);
  const leftEnd = Date.parse(left.end);
  const rightStart = Date.parse(right.start);
  const rightEnd = Date.parse(right.end);
  const leftPoint = left.temporalForm === "point";
  const rightPoint = right.temporalForm === "point";
  if (leftPoint && rightPoint) return leftStart === rightStart;
  if (leftPoint) return rightStart <= leftStart && leftStart < rightEnd;
  if (rightPoint) return leftStart <= rightStart && rightStart < leftEnd;
  return leftStart < rightEnd && leftEnd > rightStart;
}

test("civil-day arithmetic and snapping satisfy reversible algebra over representative time zones", () => {
  const zones = ["UTC", "Asia/Kolkata", "America/New_York", "Australia/Lord_Howe"];
  const start = Date.UTC(2024, 0, 1);
  const end = Date.UTC(2028, 0, 1);
  for (const zone of zones) {
    for (let cursor = start; cursor < end; cursor += DAY_MS) {
      const key = utcDateKey(cursor);
      const nextKey = utcDateKey(cursor + DAY_MS);
      const value = toDate(`${key}T12:34:00`, zone);
      const next = addDays(value, 1, zone);
      const back = addDays(next, -1, zone);
      const plain = instantToPlain(next.getTime(), zone);
      assert.equal(dateKey(next, zone), nextKey, `${zone} ${key} must advance one civil date`);
      assert.deepEqual([plain.hour, plain.minute, plain.second, plain.millisecond], [12, 34, 0, 0], `${zone} ${key} must preserve wall time`);
      assert.equal(back.getTime(), value.getTime(), `${zone} ${key} +1/-1 civil day must be reversible at an unambiguous time`);
    }
  }

  for (const slot of [1, 5, 7, 15, 30, 60, 1440]) {
    for (let value = -2880; value <= 2880; value += 1) {
      const floor = snapMinuteCoordinate(value, slot, "floor");
      const round = snapMinuteCoordinate(value, slot, "round");
      const ceil = snapMinuteCoordinate(value, slot, "ceil");
      assert.ok(floor <= value && value <= ceil, `snap bounds failed for ${value}/${slot}`);
      assert.equal(Math.abs(floor % slot), 0);
      assert.equal(Math.abs(round % slot), 0);
      assert.equal(Math.abs(ceil % slot), 0);
      assert.ok(Math.abs(round - value) <= slot / 2);
      assert.equal(snapMinuteCoordinate(round, slot, "round"), round);
    }
  }
});

test("recurrence expansion obeys partition, uniqueness, ordering and ordinal-inverse laws", () => {
  const cases = [
    {
      series: { id: "daily", start: "2024-01-01T09:00:00.000Z", end: "2024-01-01T09:00:00.000Z", temporalForm: "point" },
      recurrence: { rule: { frequency: "daily", interval: 3, count: 80 } },
      range: { start: "2024-01-01T00:00:00.000Z", end: "2025-01-01T00:00:00.000Z" },
      cuts: ["2024-01-01T00:00:00.000Z", "2024-04-01T00:00:00.000Z", "2024-07-01T00:00:00.000Z", "2024-10-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"],
      options: { timeZone: "UTC" },
    },
    {
      series: { id: "weekly", start: "2024-01-01T09:00:00.000Z", end: "2024-01-01T09:00:00.000Z", temporalForm: "point" },
      recurrence: { rule: { frequency: "weekly", interval: 2, byDay: [{ weekday: 1 }, { weekday: 3 }, { weekday: 5 }], count: 90 } },
      range: { start: "2024-01-01T00:00:00.000Z", end: "2026-01-01T00:00:00.000Z" },
      cuts: ["2024-01-01T00:00:00.000Z", "2024-07-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", "2025-07-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
      options: { timeZone: "UTC" },
    },
    {
      series: { id: "monthly", start: "2024-01-31T09:00:00.000Z", end: "2024-01-31T09:00:00.000Z", temporalForm: "point" },
      recurrence: { rule: { frequency: "monthly", byMonthDay: [1, 15, -1], count: 60 } },
      range: { start: "2024-01-01T00:00:00.000Z", end: "2026-01-01T00:00:00.000Z" },
      cuts: ["2024-01-01T00:00:00.000Z", "2024-07-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", "2025-07-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
      options: { timeZone: "UTC" },
    },
    {
      series: {
        id: "zoned-dst",
        start: "2026-03-01T02:30:00",
        end: "2026-03-01T02:30:00",
        temporalForm: "point",
        temporal: { kind: "zoned", timeZone: "America/New_York" },
      },
      recurrence: { rule: { frequency: "daily", count: 20 } },
      range: { start: "2026-03-01T00:00:00.000Z", end: "2026-03-25T00:00:00.000Z" },
      cuts: ["2026-03-01T00:00:00.000Z", "2026-03-08T00:00:00.000Z", "2026-03-15T00:00:00.000Z", "2026-03-22T00:00:00.000Z", "2026-03-25T00:00:00.000Z"],
      options: { timeZone: "America/New_York" },
    },
  ];

  for (const entry of cases) {
    const whole = expandTemporalSeries(entry.series, entry.recurrence, entry.range, entry.options);
    const partitioned = [];
    for (let index = 0; index + 1 < entry.cuts.length; index += 1) {
      partitioned.push(...expandTemporalSeries(
        entry.series,
        entry.recurrence,
        { start: entry.cuts[index], end: entry.cuts[index + 1] },
        entry.options,
      ));
    }
    assert.deepEqual(partitioned.map(row => row.originalStart), whole.map(row => row.originalStart), `${entry.series.id} partition law`);
    assert.equal(new Set(whole.map(row => row.originalStart)).size, whole.length, `${entry.series.id} identities must be unique`);
    for (let index = 1; index < whole.length; index += 1) {
      assert.ok(Date.parse(whole[index - 1].start) < Date.parse(whole[index].start), `${entry.series.id} must be strictly chronological`);
    }
    for (let index = 0; index < whole.length; index += 1) {
      const ordinal = temporalSeriesOrdinal(entry.series, entry.recurrence.rule, whole[index].originalStart, entry.options);
      assert.equal(ordinal, index + 1, `${entry.series.id} ordinal`);
      assert.equal(
        temporalSeriesIdentityAtOrdinal(entry.series, entry.recurrence.rule, ordinal, entry.options),
        whole[index].originalStart,
        `${entry.series.id} ordinal inverse`,
      );
    }
  }
});

test("timed layout is permutation-invariant and never assigns one temporal lane to overlapping occurrences", () => {
  const occurrences = [
    makeResourceOccurrence({ occurrenceId: "a", sourceItemId: "a", title: "A", start: "2026-11-10T09:00:00.000Z", end: "2026-11-10T11:00:00.000Z" }),
    makeResourceOccurrence({ occurrenceId: "b", sourceItemId: "b", title: "B", start: "2026-11-10T09:30:00.000Z", end: "2026-11-10T10:30:00.000Z" }),
    makeResourceOccurrence({ occurrenceId: "c", sourceItemId: "c", title: "C", start: "2026-11-10T10:30:00.000Z", end: "2026-11-10T12:00:00.000Z" }),
    makeResourceOccurrence({ occurrenceId: "p", sourceItemId: "p", title: "P", start: "2026-11-10T10:00:00.000Z", end: "2026-11-10T10:00:00.000Z", temporalForm: "point" }),
    makeResourceOccurrence({ occurrenceId: "d", sourceItemId: "d", title: "D", start: "2026-11-10T13:00:00.000Z", end: "2026-11-10T14:00:00.000Z" }),
  ];
  const day = "2026-11-10T00:00:00.000Z";
  const baseline = layoutTimedDay(occurrences, day, "UTC");
  const expected = layoutSignature(baseline);

  for (const input of permutations(occurrences)) {
    const layout = layoutTimedDay(input, day, "UTC");
    assert.deepEqual(layoutSignature(layout), expected);
    const byId = new Map(layout.map(row => [row.occurrence.occurrenceId, row]));
    for (const row of layout) {
      assert.ok(row.topMinutes >= 0 && row.topMinutes < 1440);
      assert.ok(row.heightMinutes >= 0);
      assert.ok(row.column >= 0 && row.column < row.columnCount);
      assert.ok(row.columnSpan >= 1 && row.column + row.columnSpan <= row.columnCount);
      assert.ok(row.visualLane >= 0 && row.visualLane < row.visualLaneCount);
      assert.equal(row.temporalForm === "point", row.heightMinutes === 0);
    }
    for (let left = 0; left < occurrences.length; left += 1) {
      for (let right = left + 1; right < occurrences.length; right += 1) {
        if (!temporalOverlap(occurrences[left], occurrences[right])) continue;
        assert.notEqual(byId.get(occurrences[left].occurrenceId).column, byId.get(occurrences[right].occurrenceId).column);
      }
    }
  }
});

test("interval collision semantics match the half-open interval model exhaustively on a finite lattice", () => {
  const intervals = [];
  for (let start = 0; start <= 8; start += 1) {
    for (let end = start + 1; end <= 9; end += 1) intervals.push([start, end]);
  }
  const at = minute => new Date(minute * 60_000);
  for (const [aStart, aEnd] of intervals) {
    for (const [bStart, bEnd] of intervals) {
      const expected = aStart < bEnd && aEnd > bStart;
      assert.equal(intervalsOverlap(at(aStart), at(aEnd), at(bStart), at(bEnd)), expected);
      assert.equal(intervalsOverlap(at(bStart), at(bEnd), at(aStart), at(aEnd)), expected);
    }
    assert.equal(intervalsOverlap(at(aStart), at(aStart), at(aStart), at(aEnd)), false);
    assert.equal(intervalsOverlap(at(aStart), at(aEnd), at(aEnd), at(aEnd)), false);
  }
  const marker = makeResourceOccurrence({ occurrenceId: "marker", sourceItemId: "marker", start: "2026-11-10T10:00:00.000Z", end: "2026-11-10T10:00:00.000Z", temporalForm: "point" });
  const block = makeResourceOccurrence({ occurrenceId: "block", sourceItemId: "block", start: "2026-11-10T09:30:00.000Z", end: "2026-11-10T10:30:00.000Z" });
  assert.deepEqual(placementCollisions([block], new Date(marker.start), new Date(marker.end), false, { mode: "prevent" }), []);
  assert.deepEqual(placementCollisions([marker], new Date(block.start), new Date(block.end), false, { mode: "prevent" }), []);
});

test("resource assignment normalization is invariant under every small-input permutation", () => {
  const resources = [
    { id: "group", title: "Rooms" },
    { id: "a", title: "A", parentId: "group", order: 2, acceptsAssignments: true },
    { id: "b", title: "B", parentId: "group", order: 1, acceptsAssignments: true },
    { id: "c", title: "C", parentId: "group", order: 3, acceptsAssignments: true },
  ];
  const occurrences = [
    makeResourceOccurrence({ occurrenceId: "x", sourceItemId: "x", title: "X" }),
    makeResourceOccurrence({ occurrenceId: "y", sourceItemId: "y", title: "Y" }),
  ];
  const expectedAssignments = [
    { occurrenceId: "x", resourceIds: ["b", "a", "c"], version: { revision: 7 } },
    { occurrenceId: "y", resourceIds: ["b", "a"] },
  ];
  const expectedAssociations = [["b", "x", 7], ["b", "y", null], ["a", "x", 7], ["a", "y", null], ["c", "x", 7]];

  for (const resourceOrder of permutations(resources)) {
    for (const occurrenceOrder of permutations(occurrences)) {
      for (const xIds of permutations(["a", "b", "c"])) {
        for (const yIds of permutations(["a", "b"])) {
          for (const assignmentOrder of permutations([
            { occurrenceId: "x", resourceIds: xIds, version: { revision: 7 } },
            { occurrenceId: "y", resourceIds: yIds },
          ])) {
            const beforeX = xIds.slice();
            const beforeY = yIds.slice();
            assert.deepEqual(
              validateCalendarResourceAssignments(resourceOrder, occurrenceOrder, assignmentOrder),
              expectedAssignments,
            );
            assert.deepEqual(
              associateCalendarResources(resourceOrder, occurrenceOrder, assignmentOrder)
                .map(row => [row.resourceId, row.occurrenceId, row.assignmentVersion?.revision ?? null]),
              expectedAssociations,
            );
            assert.deepEqual(xIds, beforeX);
            assert.deepEqual(yIds, beforeY);
          }
        }
      }
    }
  }
});

test("sync decision model covers every local/remote deletion-change state and conflict policy", () => {
  const identity = { provider: "google", connectionId: "model", externalCalendarId: "remote", eventId: "g1" };
  const base = makeCalendarItem({ ownership: "host-owned" });
  const recurrenceA = makeCalendarItem({ ownership: "host-owned", recurrence: { rule: { frequency: "weekly", interval: 2, byDay: [{ weekday: 1 }, { weekday: 3 }] } } });
  const recurrenceB = makeCalendarItem({ ownership: "host-owned", recurrence: { rule: { byDay: [{ weekday: 1 }, { weekday: 3 }], interval: 2, frequency: "weekly" } } });
  assert.equal(Sync.fingerprintCalendarItem(recurrenceA), Sync.fingerprintCalendarItem(recurrenceB));
  const localChanged = makeCalendarItem({ ownership: "host-owned", title: "Local changed" });
  const remoteChangedItem = makeCalendarItem({ ownership: "host-owned", title: "Remote changed" });
  const converged = makeCalendarItem({ ownership: "host-owned", title: "Converged" });
  const snapshot = item => ({ identity, item, deleted: false, fingerprint: Sync.fingerprintCalendarItem(item) });
  const deleted = { identity, deleted: true, fingerprint: "<deleted>" };
  const link = {
    localItemId: base.id,
    identity,
    baseLocalFingerprint: Sync.fingerprintCalendarItem(base),
    baseRemoteFingerprint: Sync.fingerprintCalendarItem(base),
    status: "clean",
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
  };
  const locals = { same: base, changed: localChanged, deleted: undefined };
  const remotes = { same: snapshot(base), changed: snapshot(remoteChangedItem), deleted, missing: undefined };
  const policies = ["manual", "prefer-local", "prefer-remote"];
  const policyAction = (manual, local, remote, policy) =>
    policy === "manual" ? manual : policy === "prefer-local" ? local : remote;
  const expected = (localState, remoteState, policy) => {
    if (localState === "same") {
      if (remoteState === "same") return "none";
      if (remoteState === "changed") return "apply-remote";
      return "delete-local";
    }
    if (localState === "changed") {
      if (remoteState === "same") return "push-local";
      if (remoteState === "changed") return policyAction("conflict", "push-local", "apply-remote", policy);
      return policyAction("conflict", "push-local", "delete-local", policy);
    }
    if (remoteState === "same") return "delete-remote";
    if (remoteState === "changed") return policyAction("conflict", "delete-remote", "apply-remote", policy);
    return "rebase";
  };
  const conflictReason = (localState, remoteState) => {
    if (localState === "changed" && remoteState === "changed") return "both-modified";
    if (localState === "changed") return "local-modified-remote-deleted";
    return "remote-modified-local-deleted";
  };

  for (const [localState, local] of Object.entries(locals)) {
    for (const [remoteState, remote] of Object.entries(remotes)) {
      for (const policy of policies) {
        const decision = Sync.decideSync(link, local, remote, policy, "2026-01-02T00:00:00.000Z");
        const action = expected(localState, remoteState, policy);
        assert.equal(decision.action, action, `${localState}/${remoteState}/${policy}`);
        if (action === "conflict") assert.equal(decision.conflict?.reason, conflictReason(localState, remoteState));
        else assert.equal(decision.conflict, undefined);
      }
    }
  }

  for (const policy of policies) {
    assert.equal(Sync.decideSync(link, converged, snapshot(converged), policy).action, "rebase");
  }
});
