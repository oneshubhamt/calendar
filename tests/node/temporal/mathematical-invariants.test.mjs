import test from "node:test";
import { deepTest } from "../../helpers/qa-tier.mjs";
import assert from "node:assert/strict";
import {
  addDays,
  dateKey,
  intervalsOverlap,
  layoutTimedDay,
  placementCollisions,
  snapMinuteCoordinate,
  toDate,
} from "../../../dist/index.js";
import { instantToPlain } from "../../../dist/core/temporal.js";
import {
  expandTemporalSeries,
  temporalSeriesIdentityAtOrdinal,
  temporalSeriesOrdinal,
} from "../../../dist/core/recurrence.js";
import { makeResourceOccurrence } from "../../fixtures/domain.mjs";
import { permutations } from "../../fixtures/combinatorics.mjs";
import { DAY_MS, utcDateKey, referenceUtcCalendarRecurrence, referenceUtcRecurrence } from "../../fixtures/reference-temporal.mjs";

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

deepTest("civil-day arithmetic and snapping satisfy reversible algebra over representative time zones", () => {
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

deepTest("recurrence expansion obeys partition, uniqueness, ordering and ordinal-inverse laws", () => {
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

test("UTC daily and weekly recurrence matches an independent civil-date enumeration across leap and year boundaries", () => {
  const models = [
    { start: "2024-02-27T10:00:00.000Z", rule: { frequency: "daily", interval: 2, count: 8 } },
    { start: "2024-12-30T09:00:00.000Z", rule: { frequency: "weekly", interval: 2, byDay: [{weekday: 1}, {weekday: 3}], count: 14 } },
    { start: "2026-11-01T09:00:00.000Z", rule: { frequency: "daily", interval: 7, count: 10 } },
  ];
  for (const {start, rule} of models) {
    const series = {id: `reference-${start}`, start, end: start, temporalForm: "point"};
    const actual = expandTemporalSeries(series, {rule}, {
      start, end: new Date(Date.parse(start) + 366 * DAY_MS).toISOString(),
    }, {timeZone: "UTC"}).map(value => value.start);
    const expected = referenceUtcRecurrence({
      start, frequency: rule.frequency, interval: rule.interval,
      weekdays: (rule.byDay ?? []).map(day => day.weekday), count: rule.count,
    });
    assert.deepEqual(actual, expected, `${start} must satisfy the independent day-scan oracle`);
  }
});

test("recurrence follows independently known leap, month-end, and DST transition instants", () => {
  const cases = [
    {
      label: "Leap year month ends",
      start: "2024-01-31T08:00:00.000Z", rule: { frequency: "monthly", byMonthDay: [-1], count: 5 },
      expected: ["2024-01-31T08:00:00.000Z", "2024-02-29T08:00:00.000Z", "2024-03-31T08:00:00.000Z", "2024-04-30T08:00:00.000Z", "2024-05-31T08:00:00.000Z"],
    },
    {
      label: "Leap day only recurring years",
      start: "2024-02-29T08:00:00.000Z", rule: { frequency: "yearly", count: 3 },
      expected: ["2024-02-29T08:00:00.000Z", "2028-02-29T08:00:00.000Z", "2032-02-29T08:00:00.000Z"],
    },
    {
      label: "New York spring-forward at unambiguous 09:00",
      start: "2026-03-06T09:00:00", zone: "America/New_York", rule: { frequency: "daily", count: 5 },
      expected: ["2026-03-06T14:00:00.000Z", "2026-03-07T14:00:00.000Z", "2026-03-08T13:00:00.000Z", "2026-03-09T13:00:00.000Z", "2026-03-10T13:00:00.000Z"],
    },
    {
      label: "New York fall-back at unambiguous 09:00",
      start: "2026-10-30T09:00:00", zone: "America/New_York", rule: { frequency: "daily", count: 5 },
      expected: ["2026-10-30T13:00:00.000Z", "2026-10-31T13:00:00.000Z", "2026-11-01T14:00:00.000Z", "2026-11-02T14:00:00.000Z", "2026-11-03T14:00:00.000Z"],
    },
    {
      label: "Lord Howe half-hour DST rollback",
      start: "2026-04-03T09:00:00", zone: "Australia/Lord_Howe", rule: { frequency: "daily", count: 4 },
      expected: ["2026-04-02T22:00:00.000Z", "2026-04-03T22:00:00.000Z", "2026-04-04T22:30:00.000Z", "2026-04-05T22:30:00.000Z"],
    },
  ];
  for (const {label, start, zone, rule, expected} of cases) {
    const series = {
      id: label, start, end: start, temporalForm: "point",
      ...(zone ? {temporal: {kind: "zoned", timeZone: zone}} : {}),
    };
    const occurrences = expandTemporalSeries(series, {rule}, {
      start: "2024-01-01T00:00:00.000Z", end: "2033-01-01T00:00:00.000Z",
    }, {timeZone: zone ?? "UTC"});
    assert.deepEqual(occurrences.map(value => value.start), expected, label);
  }
});


test("monthly and yearly recurrence match an independent bounded UTC oracle including filters limits exceptions and partitions", () => {
  const cases = [
    {
      label: "monthly negative month-days with exceptions",
      start: "2024-01-31T08:00:00.000Z",
      rule: { frequency: "monthly", byMonthDay: [1, -1], count: 10 },
      exceptions: [
        { originalStart: "2024-02-29T08:00:00.000Z", cancelled: true },
        { originalStart: "2024-04-30T08:00:00.000Z", replacement: { start: "2024-04-29T08:00:00.000Z" } },
      ],
      range: { start: "2024-01-01T00:00:00.000Z", end: "2024-07-01T00:00:00.000Z" },
      cuts: ["2024-01-01T00:00:00.000Z", "2024-03-01T00:00:00.000Z", "2024-05-01T00:00:00.000Z", "2024-07-01T00:00:00.000Z"],
    },
    {
      label: "monthly ordinal BYDAY bounded by UNTIL",
      start: "2024-01-08T09:00:00.000Z",
      rule: {
        frequency: "monthly",
        byDay: [{ weekday: 1, ordinal: 1 }, { weekday: 5, ordinal: -1 }],
        count: 50,
        until: "2024-06-30T23:59:59.999Z",
      },
      exceptions: [],
      range: { start: "2024-01-01T00:00:00.000Z", end: "2024-08-01T00:00:00.000Z" },
      cuts: ["2024-01-01T00:00:00.000Z", "2024-03-01T00:00:00.000Z", "2024-05-01T00:00:00.000Z", "2024-08-01T00:00:00.000Z"],
    },
    {
      label: "yearly selected months and negative month-day",
      start: "2024-02-29T07:00:00.000Z",
      rule: {
        frequency: "yearly",
        byMonth: [2, 11],
        byMonthDay: [-1],
        count: 8,
        until: "2027-12-31T23:59:59.999Z",
      },
      exceptions: [],
      range: { start: "2024-01-01T00:00:00.000Z", end: "2028-01-01T00:00:00.000Z" },
      cuts: ["2024-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z", "2028-01-01T00:00:00.000Z"],
    },
    {
      label: "yearly BYDAY enumerates selected month weekdays",
      start: "2024-01-15T10:00:00.000Z",
      rule: { frequency: "yearly", byMonth: [3], byDay: [{ weekday: 1 }], count: 9 },
      exceptions: [],
      range: { start: "2024-01-01T00:00:00.000Z", end: "2026-01-01T00:00:00.000Z" },
      cuts: ["2024-01-01T00:00:00.000Z", "2024-07-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", "2025-07-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    },
  ];

  for (const entry of cases) {
    const series = { id: entry.label, start: entry.start, end: entry.start, temporalForm: "point" };
    const recurrence = { rule: entry.rule, ...(entry.exceptions.length ? { exceptions: entry.exceptions } : {}) };
    const actual = expandTemporalSeries(series, recurrence, entry.range, { timeZone: "UTC" })
      .map(({ originalStart, start }) => ({ originalStart, start }));
    const expected = referenceUtcCalendarRecurrence({
      start: entry.start,
      rule: entry.rule,
      exceptions: entry.exceptions,
      rangeStart: entry.range.start,
      rangeEnd: entry.range.end,
    });
    assert.deepEqual(actual, expected, `${entry.label} must match independent UTC date-scan oracle`);

    const partitioned = [];
    for (let index = 0; index + 1 < entry.cuts.length; index += 1) {
      partitioned.push(...expandTemporalSeries(
        series,
        recurrence,
        { start: entry.cuts[index], end: entry.cuts[index + 1] },
        { timeZone: "UTC" },
      ).map(({ originalStart, start }) => ({ originalStart, start })));
    }
    assert.deepEqual(partitioned, actual, `${entry.label} must be invariant under bounded query partitioning`);
  }
});
