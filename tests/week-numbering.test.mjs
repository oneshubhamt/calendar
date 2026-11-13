import test from "node:test";
import assert from "node:assert/strict";
import { weekOfYear } from "../dist/core/time.js";
import { resolveCalendarWeekNumbering } from "../dist/view/week-numbering.js";

test("weekOfYear handles ISO-style year rollover without DOM assumptions", () => {
  assert.deepEqual(weekOfYear("2020-12-31", 1, 4, "UTC"), {
    weekYear: 2020,
    weekNumber: 53,
    weekStart: "2020-12-28",
  });
  assert.deepEqual(weekOfYear("2021-01-01", 1, 4, "UTC"), {
    weekYear: 2020,
    weekNumber: 53,
    weekStart: "2020-12-28",
  });
  assert.deepEqual(weekOfYear("2021-01-04", 1, 4, "UTC"), {
    weekYear: 2021,
    weekNumber: 1,
    weekStart: "2021-01-04",
  });
  assert.deepEqual(weekOfYear("2026-01-01", 1, 4, "UTC"), {
    weekYear: 2026,
    weekNumber: 1,
    weekStart: "2025-12-29",
  });
});

test("weekOfYear follows displayed week start and minimum-days policy", () => {
  assert.deepEqual(weekOfYear("2020-12-31", 0, 1, "UTC"), {
    weekYear: 2021,
    weekNumber: 1,
    weekStart: "2020-12-27",
  });
  assert.deepEqual(weekOfYear("2021-01-01", 0, 1, "UTC"), {
    weekYear: 2021,
    weekNumber: 1,
    weekStart: "2020-12-27",
  });
  assert.deepEqual(weekOfYear("2021-01-01", 0, 4, "UTC"), {
    weekYear: 2020,
    weekNumber: 53,
    weekStart: "2020-12-27",
  });
  assert.deepEqual(weekOfYear("2021-01-03", 0, 4, "UTC"), {
    weekYear: 2021,
    weekNumber: 1,
    weekStart: "2021-01-03",
  });
  assert.deepEqual(weekOfYear("2021-01-01", 6, 4, "UTC"), {
    weekYear: 2020,
    weekNumber: 52,
    weekStart: "2020-12-26",
  });
  assert.deepEqual(weekOfYear("2021-01-02", 6, 4, "UTC"), {
    weekYear: 2021,
    weekNumber: 1,
    weekStart: "2021-01-02",
  });
});

test("weekOfYear preserves the same civil date identity across time zones", () => {
  const zones = ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Auckland"];
  const values = zones.map(zone => weekOfYear("2026-01-01", 1, 4, zone));
  for (const value of values) assert.deepEqual(value, values[0]);

  assert.deepEqual(
    weekOfYear(new Date("2026-01-01T12:00:00.000Z"), 1, 4, "Asia/Kolkata"),
    weekOfYear("2026-01-01", 1, 4, "Asia/Kolkata"),
  );
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
