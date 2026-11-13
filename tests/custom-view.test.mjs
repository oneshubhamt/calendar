import test from "node:test";
import assert from "node:assert/strict";
import { CalendarViewRegistry } from "../dist/view/view-registry.js";

const range = { start: "2026-11-10T00:00:00.000Z", end: "2026-11-11T00:00:00.000Z" };
const plugin = (id, label = id) => ({
  id,
  label,
  range: () => range,
  shiftAnchor: context => context.anchor,
  title: () => label,
  render: () => { throw new Error("DOM renderer should not run in registry tests"); },
});

const builtIns = () => [
  plugin("month", "Month"),
  plugin("week", "Week"),
  plugin("day", "Day"),
  plugin("year", "Year"),
  plugin("agenda", "Agenda"),
];

test("custom view registry preserves built-ins and registration order while owning plugin metadata", () => {
  const custom = plugin("fortnight", "Fortnight");
  const registry = new CalendarViewRegistry(builtIns(), [custom]);
  custom.label = "Mutated later";

  assert.deepEqual(registry.entries().map(view => [view.id, view.label, view.builtIn]), [
    ["month", "Month", true],
    ["week", "Week", true],
    ["day", "Day", true],
    ["year", "Year", true],
    ["agenda", "Agenda", true],
    ["fortnight", "Fortnight", false],
  ]);
  assert.equal(registry.get("fortnight").includeBackgroundRanges, false);
  assert.equal(Object.isFrozen(registry.get("fortnight")), true);
});

test("custom view registry rejects reserved, duplicate, malformed and unknown view IDs", () => {
  assert.throws(
    () => new CalendarViewRegistry(builtIns(), [plugin("month", "Replacement")]),
    /reserved by a built-in view/i,
  );
  assert.throws(
    () => new CalendarViewRegistry(builtIns(), [plugin("custom"), plugin("custom")]),
    /Duplicate Calendar view id: custom/,
  );
  assert.throws(
    () => new CalendarViewRegistry(builtIns(), [plugin("bad view")]),
    /Calendar view id must start with a letter/i,
  );
  assert.throws(
    () => new CalendarViewRegistry(builtIns(), [{ ...plugin("broken"), render: undefined }]),
    /render must be a function/i,
  );
  assert.throws(
    () => new CalendarViewRegistry(builtIns(), [{ ...plugin("backgrounds"), includeBackgroundRanges: "yes" }]),
    /includeBackgroundRanges must be boolean/i,
  );
  const registry = new CalendarViewRegistry(builtIns(), []);
  assert.throws(() => registry.get("missing"), /Unknown Calendar view: missing/);
});

test("registry fails closed when the built-in descriptor set is incomplete or mislabeled", () => {
  assert.throws(
    () => new CalendarViewRegistry(builtIns().slice(0, 4), []),
    /Missing built-in Calendar view definition: agenda/,
  );
  assert.throws(
    () => new CalendarViewRegistry([...builtIns().slice(0, 4), plugin("fortnight")], []),
    /Unknown built-in Calendar view id: fortnight/,
  );
});
