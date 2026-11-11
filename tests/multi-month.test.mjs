import test from "node:test";
import assert from "node:assert/strict";
import { createMultiMonthView } from "../dist/view/multi-month.js";
import { dateKey } from "../dist/core/time.js";

function context(anchor = "2026-11-15T12:00:00.000Z") {
  return {
    anchor: new Date(anchor),
    locale: "en-US",
    timeZone: "UTC",
    weekStartsOn: 1,
    agendaSpan: "30-days",
  };
}

test("Multi-Month produces one contiguous detailed surface range for 2, 3, 6 and 12 months", () => {
  const expected = new Map([
    [2, ["2026-10-26", "2027-01-04"]],
    [3, ["2026-10-26", "2027-02-08"]],
    [6, ["2026-10-26", "2027-05-03"]],
    [12, ["2026-10-26", "2027-11-08"]],
  ]);

  for (const months of [2, 3, 6, 12]) {
    const plugin = createMultiMonthView({ months });
    const range = plugin.range(context());
    assert.deepEqual(
      [dateKey(range.start, "UTC"), dateKey(range.end, "UTC")],
      expected.get(months),
      `${months}-month range`,
    );
    assert.equal(plugin.includeBackgroundRanges, true);
  }
});

test("Multi-Month navigation is month-stable across years and defaults to the display span", () => {
  const three = createMultiMonthView({ months: 3 });
  assert.equal(three.shiftAnchor(context(), 1).toISOString(), "2027-02-01T00:00:00.000Z");
  assert.equal(three.shiftAnchor(context(), -1).toISOString(), "2026-08-01T00:00:00.000Z");

  const oneStep = createMultiMonthView({ months: 6, stepMonths: 1 });
  assert.equal(oneStep.shiftAnchor(context(), 1).toISOString(), "2026-12-01T00:00:00.000Z");
  assert.equal(oneStep.shiftAnchor(context(), -1).toISOString(), "2026-10-01T00:00:00.000Z");
});

test("Multi-Month titles remain explicit across same-year and cross-year spans", () => {
  const plugin = createMultiMonthView({ months: 3 });
  const crossYear = plugin.title({
    ...context(),
    visibleRange: plugin.range(context()),
  });
  assert.equal(crossYear, "November 2026 – January 2027");

  const jan = context("2027-01-15T12:00:00.000Z");
  const sameYear = plugin.title({
    ...jan,
    visibleRange: plugin.range(jan),
  });
  assert.equal(sameYear, "January – March 2027");
});

test("Multi-Month factory validates bounded composition options and supports explicit identity", () => {
  const custom = createMultiMonthView({
    id: "quarter-detail",
    label: "Quarter",
    months: 3,
    columns: 2,
    stepMonths: 1,
  });
  assert.equal(custom.id, "quarter-detail");
  assert.equal(custom.label, "Quarter");

  for (const months of [1, 13, 2.5]) {
    assert.throws(() => createMultiMonthView({ months }), /months must be an integer from 2 through 12/i);
  }
  assert.throws(() => createMultiMonthView({ months: 3, columns: 0 }), /columns must be an integer from 1 through 6/i);
  assert.throws(() => createMultiMonthView({ months: 3, columns: 7 }), /columns must be an integer from 1 through 6/i);
  assert.throws(() => createMultiMonthView({ months: 3, stepMonths: 0 }), /stepMonths must be an integer from 1 through 12/i);
  assert.throws(() => createMultiMonthView({ months: 3, stepMonths: 13 }), /stepMonths must be an integer from 1 through 12/i);
  assert.throws(
    () => createMultiMonthView({ months: 3, unexpected: true }),
    /unexpected field/i,
  );
});
