import test from "node:test";
import assert from "node:assert/strict";
import {
  CALENDAR_EXTERNAL_DROP_MIME,
  dataTransferHasType,
  decodeCalendarExternalDropData,
  normalizeCalendarExternalDropTemplate,
  resolveCalendarExternalDropDecoder,
  setCalendarExternalDropData,
} from "../dist/view/external-drop.js";

class FakeDataTransfer {
  data = new Map();
  types = [];
  effectAllowed = "all";
  dropEffect = "none";

  setData(type, value) {
    if (!this.data.has(type)) this.types.push(type);
    this.data.set(type, String(value));
  }

  getData(type) {
    return this.data.get(type) ?? "";
  }
}

test("external-drop template validation owns bounded generic data and rejects malformed input", () => {
  const metadata = { origin: "outside", nested: { count: 2 } };
  const template = normalizeCalendarExternalDropTemplate({
    title: "  Outside task  ",
    calendarId: "personal",
    description: "  Notes  ",
    kind: "task",
    durationMinutes: 45,
    durationDays: 2,
    temporalForm: "interval",
    metadata,
  });

  assert.equal(template.title, "Outside task");
  assert.equal(template.description, "Notes");
  assert.equal(template.durationMinutes, 45);
  assert.equal(template.durationDays, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(template.metadata)), metadata);
  assert.notEqual(template.metadata, metadata);
  metadata.nested.count = 99;
  assert.equal(template.metadata.nested.count, 2);

  assert.equal(normalizeCalendarExternalDropTemplate({}), undefined);
  assert.equal(normalizeCalendarExternalDropTemplate({ title: "x", durationMinutes: 0 }), undefined);
  assert.equal(normalizeCalendarExternalDropTemplate({ title: "x", temporalForm: "date" }), undefined);
  assert.equal(normalizeCalendarExternalDropTemplate({ title: "x", display: { dimmed: "yes" } }), undefined);

  const cycle = {};
  cycle.self = cycle;
  assert.equal(normalizeCalendarExternalDropTemplate({ title: "x", metadata: cycle }), undefined);
});

test("standard external-drop MIME helper round-trips owned data and malformed payloads fail closed", () => {
  const transfer = new FakeDataTransfer();
  setCalendarExternalDropData(transfer, {
    title: "Dropped event",
    durationMinutes: 90,
    metadata: { origin: "fixture" },
  });

  assert.equal(transfer.effectAllowed, "copy");
  assert.equal(dataTransferHasType(transfer, CALENDAR_EXTERNAL_DROP_MIME), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(decodeCalendarExternalDropData(transfer))),
    {
      title: "Dropped event",
      durationMinutes: 90,
      metadata: { origin: "fixture" },
    },
  );

  const malformed = new FakeDataTransfer();
  malformed.setData(CALENDAR_EXTERNAL_DROP_MIME, "{not-json");
  assert.equal(decodeCalendarExternalDropData(malformed), undefined);

  const unknown = new FakeDataTransfer();
  unknown.setData("application/x-unknown", "anything");
  assert.equal(decodeCalendarExternalDropData(unknown), undefined);
  assert.equal(dataTransferHasType(null, CALENDAR_EXTERNAL_DROP_MIME), false);
});

test("custom decoder declarations are validated once and preserve synchronous ownership semantics", () => {
  let calls = 0;
  const decoder = resolveCalendarExternalDropDecoder({
    types: ["application/x-host-task", "application/x-host-task"],
    decode(dataTransfer) {
      calls += 1;
      return JSON.parse(dataTransfer.getData("application/x-host-task"));
    },
  });

  assert.deepEqual(decoder.types, ["application/x-host-task"]);
  const transfer = new FakeDataTransfer();
  transfer.setData("application/x-host-task", JSON.stringify({ title: "Host task" }));
  assert.deepEqual(decoder.decode(transfer), { title: "Host task" });
  assert.equal(calls, 1);

  assert.throws(
    () => resolveCalendarExternalDropDecoder({ types: [], decode() { return null; } }),
    /MIME types are invalid/i,
  );
  assert.throws(
    () => resolveCalendarExternalDropDecoder({ types: ["bad type"], decode() { return null; } }),
    /MIME types are invalid/i,
  );
  assert.throws(
    () => resolveCalendarExternalDropDecoder({ types: ["application/x-host-task"], decode: null }),
    /decoder is invalid/i,
  );
});
