import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../../../dist/index.js";
import { createSeededRandom, seededInt } from "../../fixtures/seeded.mjs";

const DAY_MS = 86_400_000;
const source = { id: "personal", title: "Personal", visible: true, removable: true };
const context = { now: "2026-11-01T00:00:00.000Z", timeZone: "UTC" };

function plusMinutes(value, minutes) {
  return new Date(Date.parse(value) + minutes * 60_000).toISOString();
}

function plusDays(value, days) {
  return new Date(Date.parse(value) + days * DAY_MS).toISOString();
}

function semanticItems(items) {
  return items.map(item => ({
    id: item.id,
    calendarId: item.calendarId,
    title: item.title,
    start: item.start,
    end: item.end,
    seriesId: item.seriesId,
    recurrence: item.recurrence ? {
      rule: structuredClone(item.recurrence.rule),
      exceptions: item.recurrence.exceptions ? structuredClone(item.recurrence.exceptions) : undefined,
    } : undefined,
  }));
}

function occurrenceAt(item, ordinal) {
  const interval = item.recurrence?.rule.interval ?? 1;
  const offsetDays = item.recurrence ? (ordinal - 1) * interval : 0;
  const start = plusDays(item.start, offsetDays);
  const end = plusDays(item.end, offsetDays);
  const { id: _id, recurrence: _recurrence, ...fields } = item;
  return {
    ...fields,
    start,
    end,
    occurrenceId: `model:${item.id}:${ordinal}`,
    sourceItemId: item.id,
    originalStart: start,
    recurring: Boolean(item.recurrence),
  };
}

function modelOccurrences(items, range) {
  const out = [];
  for (const item of items) {
    const count = item.recurrence?.rule.count ?? 1;
    const interval = item.recurrence?.rule.interval ?? 1;
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      const start = plusDays(item.start, (ordinal - 1) * interval);
      const end = plusDays(item.end, (ordinal - 1) * interval);
      if (Date.parse(start) < Date.parse(range.end) && Date.parse(end) > Date.parse(range.start)) {
        out.push({ sourceItemId: item.id, originalStart: start, start, end });
      }
    }
  }
  return out.sort((left, right) =>
    Date.parse(left.start) - Date.parse(right.start)
    || left.sourceItemId.localeCompare(right.sourceItemId)
    || left.originalStart.localeCompare(right.originalStart));
}

function splitModel(item, occurrence, start, end, ordinal) {
  const originalCount = item.recurrence.rule.count;
  const first = {
    ...item,
    recurrence: {
      ...item.recurrence,
      rule: { ...item.recurrence.rule, count: ordinal - 1, until: undefined },
      exceptions: undefined,
    },
  };
  const tailId = `${item.id}:split:${Date.parse(occurrence.start)}`;
  const tail = {
    ...item,
    id: tailId,
    seriesId: tailId,
    start,
    end,
    recurrence: {
      ...item.recurrence,
      rule: { ...item.recurrence.rule, count: originalCount - ordinal + 1, until: item.recurrence.rule.until },
      exceptions: undefined,
    },
  };
  return [first, tail];
}

async function assertModel(repo, engine, model, range, label) {
  const snapshot = repo.read();
  assert.equal(snapshot.revision, model.revision, `${label}: repository revision`);
  assert.deepEqual(semanticItems(snapshot.items), semanticItems(model.items), `${label}: canonical items`);

  const query = await engine.query(range, { timeZone: "UTC" });
  assert.equal(query.repositoryRevision, model.revision, `${label}: query revision`);
  assert.equal(query.generation, model.revision, `${label}: invalidation generation`);
  const actualOccurrences = query.occurrences
    .map(({ sourceItemId, originalStart, start, end }) => ({ sourceItemId, originalStart, start, end }))
    .sort((left, right) =>
      Date.parse(left.start) - Date.parse(right.start)
      || left.sourceItemId.localeCompare(right.sourceItemId)
      || left.originalStart.localeCompare(right.originalStart));
  assert.deepEqual(actualOccurrences, modelOccurrences(model.items, range), `${label}: refreshed occurrences`);
}

test("seeded calendar state machine agrees with an independent reference model across mutation history and refresh", async () => {
  const seeds = [0x13579bdf, 0x2468ace0, 0xc0ffee11];

  for (const seed of seeds) {
    const random = createSeededRandom(seed);
    const day = seededInt(random, 4, 8);
    const hour = seededInt(random, 8, 11);
    const durationMinutes = seededInt(random, 2, 4) * 15;
    const moveMinutes = seededInt(random, 1, 4) * 15;
    const resizeMinutes = seededInt(random, 1, 3) * 15;
    const interval = seededInt(random, 2, 3);
    const count = seededInt(random, 6, 8);
    const splitOrdinal = seededInt(random, 2, Math.min(4, count - 1));
    const tailShiftMinutes = seededInt(random, 1, 4) * 15;

    const anchor = new Date(Date.UTC(2026, 10, day, hour, 0, 0)).toISOString();
    const item = {
      id: `series-${seed.toString(16)}`,
      calendarId: source.id,
      title: `Seed ${seed.toString(16)}`,
      start: anchor,
      end: plusMinutes(anchor, durationMinutes),
      kind: "event",
      ownership: "calendar",
      editPolicy: "full",
      seriesId: `series-${seed.toString(16)}`,
      recurrence: { rule: { frequency: "daily", count } },
    };

    const repo = new C.MemoryCalendarRepository([source], []);
    const engine = new C.CalendarEngine(repo);
    const unsubscribe = engine.subscribe(() => {});
    const handler = new C.RepositoryCommandHandler(repo);
    const model = { revision: 0, items: [] };
    const range = {
      start: plusDays(anchor, -1),
      end: plusDays(anchor, interval * count + 8),
    };

    await handler.execute({ type: "create", item }, context);
    model.items = [structuredClone(item)];
    model.revision += 1;
    await assertModel(repo, engine, model, range, `seed ${seed} create`);

    let occurrence = occurrenceAt(model.items[0], 1);
    const movedStart = plusMinutes(occurrence.start, moveMinutes);
    const movedEnd = plusMinutes(occurrence.end, moveMinutes);
    await handler.execute({
      type: "move-occurrence", occurrence, start: movedStart, end: movedEnd, scope: "all",
    }, context);
    model.items[0] = { ...model.items[0], start: movedStart, end: movedEnd };
    model.revision += 1;
    await assertModel(repo, engine, model, range, `seed ${seed} move`);

    occurrence = occurrenceAt(model.items[0], 1);
    const resizedEnd = plusMinutes(occurrence.end, resizeMinutes);
    await handler.execute({
      type: "resize-occurrence", occurrence, start: occurrence.start, end: resizedEnd, scope: "all",
    }, context);
    model.items[0] = { ...model.items[0], end: resizedEnd };
    model.revision += 1;
    await assertModel(repo, engine, model, range, `seed ${seed} resize`);

    occurrence = occurrenceAt(model.items[0], 1);
    const editedRecurrence = { rule: { frequency: "daily", interval, count } };
    await handler.execute({
      type: "update-occurrence", occurrence, patch: { recurrence: editedRecurrence }, scope: "all",
    }, context);
    model.items[0] = { ...model.items[0], recurrence: structuredClone(editedRecurrence) };
    model.revision += 1;
    await assertModel(repo, engine, model, range, `seed ${seed} recurrence edit`);

    const beforeSplit = structuredClone(model.items);
    occurrence = occurrenceAt(model.items[0], splitOrdinal);
    const tailStart = plusMinutes(occurrence.start, tailShiftMinutes);
    const tailEnd = plusMinutes(occurrence.end, tailShiftMinutes);
    await handler.execute({
      type: "move-occurrence", occurrence, start: tailStart, end: tailEnd, scope: "this-and-following",
    }, context);
    model.items = splitModel(model.items[0], occurrence, tailStart, tailEnd, splitOrdinal);
    model.revision += 1;
    await assertModel(repo, engine, model, range, `seed ${seed} split`);

    const afterSplit = structuredClone(model.items);
    assert.equal(await handler.undo(), true);
    model.items = beforeSplit;
    model.revision += 1;
    assert.deepEqual(handler.historyState(), { canUndo: true, canRedo: true });
    await assertModel(repo, engine, model, range, `seed ${seed} undo`);

    assert.equal(await handler.redo(), true);
    model.items = afterSplit;
    model.revision += 1;
    assert.deepEqual(handler.historyState(), { canUndo: true, canRedo: false });
    await assertModel(repo, engine, model, range, `seed ${seed} redo`);

    const beforeStale = repo.read();
    assert.throws(
      () => repo.replaceAtRevision(beforeStale.items, beforeStale.revision - 1),
      error => error instanceof C.CalendarStaleRevisionError
        && error.expectedRevision === beforeStale.revision - 1
        && error.actualRevision === beforeStale.revision,
    );
    assert.strictEqual(repo.read(), beforeStale, `seed ${seed}: stale CAS must not publish a new snapshot`);
    await assertModel(repo, engine, model, range, `seed ${seed} stale CAS refresh`);

    unsubscribe();
  }
});

test("multi-record recurrence split rolls back completely when staged tail creation fails", async () => {
  const recurring = {
    id: "rollback-series",
    calendarId: source.id,
    title: "Rollback series",
    start: "2026-11-10T09:00:00.000Z",
    end: "2026-11-10T10:00:00.000Z",
    kind: "event",
    ownership: "calendar",
    editPolicy: "full",
    seriesId: "rollback-series",
    recurrence: { rule: { frequency: "daily", count: 4 } },
  };
  const occurrence = occurrenceAt(recurring, 3);
  const collidingTailId = `${recurring.id}:split:${Date.parse(occurrence.start)}`;
  const blocker = {
    ...recurring,
    id: collidingTailId,
    seriesId: undefined,
    title: "Existing blocker",
    start: "2026-11-20T09:00:00.000Z",
    end: "2026-11-20T10:00:00.000Z",
    recurrence: undefined,
  };
  const repo = new C.MemoryCalendarRepository([source], [recurring, blocker]);
  const handler = new C.RepositoryCommandHandler(repo);
  const before = repo.read();

  await assert.rejects(
    () => handler.execute({
      type: "move-occurrence",
      occurrence,
      start: plusMinutes(occurrence.start, 30),
      end: plusMinutes(occurrence.end, 30),
      scope: "this-and-following",
    }, context),
    /duplicate calendar item/i,
  );

  assert.strictEqual(repo.read(), before, "failed staging must not publish the first half of a split");
  assert.equal(repo.read().revision, 0);
  assert.deepEqual(handler.historyState(), { canUndo: false, canRedo: false });
});
