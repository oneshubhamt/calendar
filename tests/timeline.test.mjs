import test from "node:test";
import assert from "node:assert/strict";
import {
  horizontalTimelineTicks,
  layoutHorizontalTimeline,
  resolveHorizontalTimelineRangeGeometry,
} from "../dist/index.js";
import { createTimelineView } from "../dist/view/timeline.js";
import { dateKey } from "../dist/core/time.js";

function nav(anchor = "2026-11-10T12:00:00.000Z") {
  return {
    anchor: new Date(anchor),
    locale: "en-US",
    timeZone: "UTC",
    weekStartsOn: 1,
    agendaSpan: "30-days",
  };
}

test("generic horizontal timeline clips intervals, preserves points and assigns visual lanes", () => {
  const range = { start: "2026-11-10T09:00:00.000Z", end: "2026-11-10T12:00:00.000Z" };
  const rows = layoutHorizontalTimeline([
    { id: "carry", start: "2026-11-10T08:30:00.000Z", end: "2026-11-10T10:30:00.000Z", value: "carry" },
    { id: "block", start: "2026-11-10T10:00:00.000Z", end: "2026-11-10T11:00:00.000Z", value: "block" },
    { id: "point-a", start: "2026-11-10T10:15:00.000Z", end: "2026-11-10T10:15:00.000Z", temporalForm: "point", value: "point-a" },
    { id: "point-b", start: "2026-11-10T10:15:00.000Z", end: "2026-11-10T10:15:00.000Z", temporalForm: "point", value: "point-b" },
  ], range, { timeZone: "UTC" });

  const byId = new Map(rows.map(row => [row.id, row]));
  assert.deepEqual(
    [byId.get("carry").xMinutes, byId.get("carry").widthMinutes, byId.get("carry").clippedStart],
    [0, 90, "2026-11-10T09:00:00.000Z"],
  );
  assert.equal(byId.get("point-a").widthMinutes, 0);
  assert.equal(byId.get("point-b").widthMinutes, 0);
  assert.equal(new Set(rows.map(row => row.lane)).size, 4);
  assert.equal(new Set(rows.map(row => row.laneCount)).size, 1);
  assert.equal(rows[0].laneCount, 4);
});

test("generic horizontal timeline supports independent lane groups for resource and ordinary surfaces", () => {
  const rows = layoutHorizontalTimeline([
    { id: "a-1", start: "2026-11-10T09:00:00.000Z", end: "2026-11-10T11:00:00.000Z", laneGroup: 0, value: "a" },
    { id: "a-2", start: "2026-11-10T10:00:00.000Z", end: "2026-11-10T12:00:00.000Z", laneGroup: 0, value: "b" },
    { id: "b-1", start: "2026-11-10T10:00:00.000Z", end: "2026-11-10T12:00:00.000Z", laneGroup: 1, value: "c" },
  ], { start: "2026-11-10T08:00:00.000Z", end: "2026-11-10T13:00:00.000Z" }, { timeZone: "UTC" });
  assert.deepEqual(rows.map(row => [row.id, row.laneGroup, row.lane, row.laneCount]), [
    ["a-1", 0, 0, 2],
    ["a-2", 0, 1, 2],
    ["b-1", 1, 0, 1],
  ]);
});

test("horizontal civil geometry preserves DST semantics and inverse coordinates fail closed on gaps", () => {
  const spring = resolveHorizontalTimelineRangeGeometry({
    start: "2026-03-08T05:00:00.000Z",
    end: "2026-03-09T04:00:00.000Z",
  }, "America/New_York");
  assert.equal(spring.widthMinutes, 1440);
  assert.equal(spring.coordinate(Date.parse("2026-03-08T06:30:00.000Z")), 90);
  assert.equal(spring.coordinate(Date.parse("2026-03-08T07:30:00.000Z")), 210);
  assert.equal(spring.instantAtCoordinate(150, "earlier"), null, "02:30 local is inside the spring gap");

  const fall = resolveHorizontalTimelineRangeGeometry({
    start: "2026-11-01T04:00:00.000Z",
    end: "2026-11-02T05:00:00.000Z",
  }, "America/New_York");
  assert.equal(fall.coordinate(Date.parse("2026-11-01T05:30:00.000Z")), 90);
  assert.equal(fall.coordinate(Date.parse("2026-11-01T06:30:00.000Z")), 90);
  assert.equal(
    fall.instantAtCoordinate(90, "later").getTime() - fall.instantAtCoordinate(90, "earlier").getTime(),
    60 * 60_000,
  );
});

test("horizontal axis ticks remain bounded and deduplicate folded civil coordinates", () => {
  const geometry = resolveHorizontalTimelineRangeGeometry({
    start: "2026-11-01T04:00:00.000Z",
    end: "2026-11-02T05:00:00.000Z",
  }, "America/New_York");
  const ticks = horizontalTimelineTicks(geometry, 60);
  assert.ok(ticks.length <= 25);
  assert.equal(new Set(ticks.map(tick => tick.coordinate.toFixed(6))).size, ticks.length);
  assert.throws(() => horizontalTimelineTicks(geometry, 0), /positive/i);
});

test("Timeline view owns a civil visible span and month/year-independent navigation", () => {
  const view = createTimelineView({ spanDays: 7, stepDays: 3 });
  const context = nav();
  const range = view.range(context);
  assert.deepEqual([dateKey(range.start, "UTC"), dateKey(range.end, "UTC")], ["2026-11-10", "2026-11-17"]);
  assert.equal(view.shiftAnchor(context, 1).toISOString(), "2026-11-13T00:00:00.000Z");
  assert.equal(view.shiftAnchor(context, -1).toISOString(), "2026-11-07T00:00:00.000Z");
  assert.equal(view.includeBackgroundRanges, true);
  assert.equal(view.title({ ...context, visibleRange: range }), "Nov 10, 2026 – Nov 16, 2026");
});

test("Timeline factory validates bounded configuration and custom identity", () => {
  const view = createTimelineView({
    id: "fortnight",
    label: "Fortnight",
    spanDays: 14,
    stepDays: 7,
    pixelsPerHour: 48,
    minWidth: 800,
    axisTickMinutes: 720,
    eventHeight: 28,
    minTrackHeight: 140,
  });
  assert.equal(view.id, "fortnight");
  assert.equal(view.label, "Fortnight");
  assert.throws(() => createTimelineView({ spanDays: 0 }), /spanDays/i);
  assert.throws(() => createTimelineView({ spanDays: 91 }), /spanDays/i);
  assert.throws(() => createTimelineView({ stepDays: 0 }), /stepDays/i);
  assert.throws(() => createTimelineView({ pixelsPerHour: 0 }), /pixelsPerHour/i);
  assert.throws(() => createTimelineView({ axisTickMinutes: Number.NaN }), /axisTickMinutes/i);
  assert.throws(() => createTimelineView({ unexpected: true }), /unexpected field/i);
});
