import test from "node:test";
import { deepTest } from "../../helpers/qa-tier.mjs";
import assert from "node:assert/strict";
import { weekOfYear } from "../../../dist/core/time.js";
import { resolveCalendarWeekNumbering } from "../../../dist/view/week-numbering.js";
import { DAY_MS } from "../../fixtures/reference-temporal.mjs";

function isoWeekReference(date) {
  const value = new Date(date.getTime());
  const weekday = value.getUTCDay() || 7;
  const weekStart = new Date(value.getTime() - (weekday - 1) * DAY_MS);
  const thursday = new Date(value.getTime() + (4 - weekday) * DAY_MS);
  const weekYear = thursday.getUTCFullYear();
  const january4 = new Date(Date.UTC(weekYear, 0, 4));
  const january4Weekday = january4.getUTCDay() || 7;
  const firstWeekStart = new Date(january4.getTime() - (january4Weekday - 1) * DAY_MS);
  return {
    weekYear,
    weekNumber: Math.floor((weekStart.getTime() - firstWeekStart.getTime()) / (7 * DAY_MS)) + 1,
    weekStart: weekStart.toISOString().slice(0, 10),
  };
}

deepTest("ISO week identity matches an independent reference over the complete 400-year Gregorian cycle", () => {
  const zones = ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Auckland"];
  const start = Date.UTC(2000, 0, 1);
  const end = Date.UTC(2400, 0, 1);
  let ordinal = 0;
  for (let epoch = start; epoch < end; epoch += DAY_MS, ordinal += 1) {
    const date = new Date(epoch);
    const key = date.toISOString().slice(0, 10);
    const expected = isoWeekReference(date);
    assert.deepEqual(weekOfYear(key, 1, 4, "UTC"), expected, key);
    if (ordinal % 997 === 0) {
      for (const zone of zones) assert.deepEqual(weekOfYear(key, 1, 4, zone), expected, `${key} in ${zone}`);
    }
  }
});

test("weekOfYear fails closed on invalid policy values", () => {
  assert.throws(() => weekOfYear("2026-01-01", -1, 4, "UTC"), /weekStartsOn/i);
  assert.throws(() => weekOfYear("2026-01-01", 7, 4, "UTC"), /weekStartsOn/i);
  assert.throws(() => weekOfYear("2026-01-01", 1, 0, "UTC"), /minimumDaysInFirstWeek/i);
  assert.throws(() => weekOfYear("2026-01-01", 1, 8, "UTC"), /minimumDaysInFirstWeek/i);
});


test("view week-number policy supports locale defaults and deterministic overrides", () => {
  assert.equal(resolveCalendarWeekNumbering("en-US", false), undefined);
  assert.equal(resolveCalendarWeekNumbering("en-US", undefined), undefined);
  assert.deepEqual(resolveCalendarWeekNumbering("en-US", { minimumDaysInFirstWeek: 4 }), {
    minimumDaysInFirstWeek: 4,
  });

  const locale = new Intl.Locale("en-US");
  const info = typeof locale.getWeekInfo === "function" ? locale.getWeekInfo() : locale.weekInfo;
  const expected = Number.isInteger(info?.minimalDays) ? info.minimalDays : 4;
  assert.equal(resolveCalendarWeekNumbering("en-US", true)?.minimumDaysInFirstWeek, expected);

  assert.throws(
    () => resolveCalendarWeekNumbering("en-US", { minimumDaysInFirstWeek: 0 }),
    /minimumDaysInFirstWeek/i,
  );
  assert.throws(
    () => resolveCalendarWeekNumbering("en-US", { minimumDaysInFirstWeek: 8 }),
    /minimumDaysInFirstWeek/i,
  );
  assert.throws(
    () => resolveCalendarWeekNumbering("en-US", { minimumDaysInFirstWeek: 4, extra: true }),
    /unexpected field/i,
  );
});
