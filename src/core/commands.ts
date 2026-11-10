import type {
  CalendarCommand,
  CalendarCommandContext,
  CalendarCommandHandler,
  CalendarItem,
  CalendarItemPatch,
  CalendarOccurrence,
  CalendarRecurrence,
  CalendarRepository,
  CalendarSnapshot,
  CalendarSource,
  RecurrenceException,
} from "./types.js";
import { projectTemporalPatchToSeries, rebaseTemporalSeriesExceptions, sameRecurrence, temporalSeriesIdentityAtOrdinal, temporalSeriesOrdinal } from "./recurrence.js";
import { applyCalendarItemPatch, assertCalendarStateIntegrity, materializeCalendarSnapshot } from "./store.js";
import { CalendarStaleError } from "./revision.js";

/** Host command rejection caused by obsolete authoritative state. */
export class CalendarCommandStaleError extends CalendarStaleError {
  public constructor(message = "Calendar command rejected because the authoritative state changed") {
    super(message);
    this.name = "CalendarCommandStaleError";
  }
}

function assertEditablePolicy(id: string, editPolicy: CalendarItem["editPolicy"]): void {
  if (editPolicy === "readonly" || editPolicy === "generated") throw new Error(`Calendar item ${id} is not directly editable`);
}

function assertEditable(occurrence: CalendarOccurrence): void {
  assertEditablePolicy(occurrence.sourceItemId, occurrence.editPolicy);
}

function assertEditableItem(item: CalendarItem): void {
  assertEditablePolicy(item.id, item.editPolicy);
}

const SCHEDULE_ONLY_PATCH_FIELDS = new Set(["start", "end", "allDay", "precision", "temporal"]);

function assertPatchAllowed(item: CalendarItem | CalendarOccurrence, patch: CalendarItemPatch): void {
  if (item.editPolicy !== "schedule-only") return;
  const semantic = Object.keys(patch).filter(key => !SCHEDULE_ONLY_PATCH_FIELDS.has(key));
  if (semantic.length) throw new Error(`Calendar item ${"id" in item ? item.id : item.sourceItemId} is schedule-only; semantic fields cannot be changed (${semantic.join(", ")})`);
}

function withException(item: CalendarItem, occurrence: CalendarOccurrence, patch: CalendarItemPatch | null): CalendarRecurrence {
  if (!item.recurrence) throw new Error("Occurrence does not belong to a recurring series");
  const existing = item.recurrence.exceptions?.filter(exception => exception.originalStart !== occurrence.originalStart) ?? [];
  const next: RecurrenceException = patch === null
    ? { originalStart: occurrence.originalStart, cancelled: true }
    : { originalStart: occurrence.originalStart, replacement: patch };
  return { ...item.recurrence, exceptions: [...existing, next] };
}

function itemById(repository: CalendarRepository, id: string): CalendarItem {
  const item = repository.read().items.find(candidate => candidate.id === id);
  if (!item) throw new Error(`Calendar item not found: ${id}`);
  return item;
}

function sourceById(repository: CalendarRepository, id: string): CalendarSource {
  const source = repository.read().sources.find(candidate => candidate.id === id);
  if (!source) throw new Error(`Calendar source not found: ${id}`);
  return source;
}

function assertSourceMutable(repository: CalendarRepository, calendarId: string): CalendarSource {
  const source = sourceById(repository, calendarId);
  if (source.readOnly) throw new Error(`Calendar source ${calendarId} is read-only`);
  return source;
}

function assertSourceAllowsCreate(repository: CalendarRepository, calendarId: string): CalendarSource {
  const source = assertSourceMutable(repository, calendarId);
  if (source.allowCreate === false) throw new Error(`Calendar source ${calendarId} does not allow item creation`);
  return source;
}

function assertPatchSourceAllowed(repository: CalendarRepository, item: CalendarItem, patch: CalendarItemPatch): void {
  assertSourceMutable(repository, item.calendarId);
  if (patch.calendarId !== undefined && patch.calendarId !== item.calendarId) assertSourceAllowsCreate(repository, patch.calendarId);
}

function movedPatch(start: string, end: string): CalendarItemPatch {
  return { start, end };
}

function withoutRecurrence(patch: CalendarItemPatch): CalendarItemPatch {
  if (patch.recurrence === undefined) return patch;
  const { recurrence: _recurrence, ...rest } = patch;
  return rest;
}


function seriesPatch(
  item: CalendarItem,
  occurrence: CalendarOccurrence,
  patch: CalendarItemPatch,
  context: CalendarCommandContext,
): CalendarItemPatch {
  if (!item.recurrence) return patch;
  const temporalPatch = projectTemporalPatchToSeries(item, occurrence, patch, { timeZone: context.timeZone });
  const nextRecurrence = temporalPatch.recurrence === null ? undefined : temporalPatch.recurrence ?? item.recurrence;
  if (!nextRecurrence) return temporalPatch;
  const nextItem = {
    ...item,
    start: temporalPatch.start ?? item.start,
    end: temporalPatch.end ?? item.end,
    recurrence: nextRecurrence,
  };
  const rebased = rebaseTemporalSeriesExceptions(
    item,
    item.recurrence,
    nextItem,
    nextItem.recurrence,
    { timeZone: context.timeZone },
  );
  return { ...temporalPatch, recurrence: rebased ?? null };
}

function splitSeries(
  item: CalendarItem,
  occurrence: CalendarOccurrence,
  patch: CalendarItemPatch,
  context: CalendarCommandContext,
): readonly CalendarItem[] {
  if (!item.recurrence) throw new Error("Cannot split a non-recurring item");
  const ordinal = temporalSeriesOrdinal(item, item.recurrence?.rule, occurrence.originalStart, { timeZone: context.timeZone });
  const beforeExceptions: RecurrenceException[] = [];
  const afterExceptions: Array<{ readonly ordinal: number; readonly exception: RecurrenceException }> = [];
  for (const exception of item.recurrence.exceptions ?? []) {
    try {
      const position = temporalSeriesOrdinal(item, item.recurrence?.rule, exception.originalStart, { timeZone: context.timeZone });
      if (position < ordinal) beforeExceptions.push(exception);
      else afterExceptions.push({ ordinal: position, exception });
    } catch {
      // Ignore orphaned historical exception keys instead of attaching them to the wrong series.
    }
  }
  const first: CalendarItem = {
    ...item,
    recurrence: {
      ...item.recurrence,
      rule: { ...item.recurrence.rule, count: Math.max(1, ordinal - 1), until: undefined },
      ...(beforeExceptions.length ? { exceptions: beforeExceptions } : { exceptions: undefined }),
    },
    updatedAt: context.now,
  };
  const tailPatch = projectTemporalPatchToSeries(item, occurrence, { ...patch, start: patch.start ?? occurrence.start }, { timeZone: context.timeZone });
  const nextStart = tailPatch.start ?? item.start;
  const nextEnd = tailPatch.end ?? item.end;
  const remainingCount = item.recurrence.rule.count === undefined ? undefined : Math.max(1, item.recurrence.rule.count - ordinal + 1);
  const secondId = `${item.id}:split:${Date.parse(occurrence.start)}`;
  const recurrencePatch = patch.recurrence;
  const recurrenceRuleChanged = recurrencePatch !== undefined && recurrencePatch !== null
    && JSON.stringify(recurrencePatch.rule) !== JSON.stringify(item.recurrence.rule);
  const baseSecondRecurrence = recurrencePatch === null
    ? undefined
    : recurrencePatch && recurrenceRuleChanged
      ? { ...recurrencePatch, exceptions: undefined }
      : {
        ...item.recurrence,
        rule: { ...item.recurrence.rule, count: remainingCount, until: item.recurrence.rule.until },
        exceptions: undefined,
      };
  let second: CalendarItem = {
    ...item,
    ...withoutRecurrence(tailPatch),
    id: secondId,
    seriesId: secondId,
    start: nextStart,
    end: nextEnd,
    ...(baseSecondRecurrence ? { recurrence: baseSecondRecurrence } : { recurrence: undefined }),
    createdAt: context.now,
    updatedAt: context.now,
  } as CalendarItem;
  if (second.recurrence && afterExceptions.length) {
    const mapped: RecurrenceException[] = [];
    for (const row of afterExceptions) {
      try {
        const originalStart = temporalSeriesIdentityAtOrdinal(second, second.recurrence?.rule, row.ordinal - ordinal + 1, { timeZone: context.timeZone });
        mapped.push({ ...row.exception, originalStart });
      } catch {
        // The replacement rule can legitimately be shorter than the old tail.
      }
    }
    second = { ...second, recurrence: { ...second.recurrence, ...(mapped.length ? { exceptions: mapped } : { exceptions: undefined }) } };
  }
  return [first, second];
}

async function applyOccurrencePatch(
  repository: CalendarRepository,
  occurrence: CalendarOccurrence,
  patch: CalendarItemPatch,
  scope: "this" | "this-and-following" | "all",
  context: CalendarCommandContext,
): Promise<void> {
  assertEditable(occurrence);
  const item = itemById(repository, occurrence.sourceItemId);
  assertEditableItem(item);
  assertPatchAllowed(item, patch);
  assertPatchSourceAllowed(repository, item, patch);
  if (!item.recurrence) {
    await repository.update(item.id, projectTemporalPatchToSeries(item, occurrence, patch, { timeZone: context.timeZone }));
    return;
  }
  if (scope === "all") {
    await repository.update(item.id, seriesPatch(item, occurrence, patch, context));
    return;
  }
  if (scope === "this") {
    if (patch.recurrence !== undefined && !sameRecurrence(item.recurrence, patch.recurrence)) throw new Error("A single occurrence cannot own a different recurrence rule");
    await repository.update(item.id, { recurrence: withException(item, occurrence, withoutRecurrence(patch)) });
    return;
  }
  if (temporalSeriesOrdinal(item, item.recurrence?.rule, occurrence.originalStart, { timeZone: context.timeZone }) === 1) {
    await repository.update(item.id, seriesPatch(item, occurrence, patch, context));
    return;
  }
  const [first, second] = splitSeries(item, occurrence, patch, context);
  await repository.update(item.id, { start: first!.start, end: first!.end, recurrence: first!.recurrence ?? null });
  await repository.create(second!);
}

/**
 * Command-local copy-on-write staging repository. It starts from the immutable authoritative
 * snapshot, structurally shares unchanged entities, and owns every changed/new value before
 * command execution yields. Nothing is published or persisted until the final guarded commit.
 */
class CommandStagingRepository implements CalendarRepository {
  private snapshotValue: CalendarSnapshot;

  public constructor(snapshot: CalendarSnapshot) {
    this.snapshotValue = snapshot;
  }

  public read(): CalendarSnapshot {
    return this.snapshotValue;
  }

  public create(item: CalendarItem): void {
    this.stage([...this.snapshotValue.items, item]);
  }

  public update(id: string, patch: CalendarItemPatch): void {
    const index = this.snapshotValue.items.findIndex(item => item.id === id);
    if (index < 0) throw new Error(`Calendar item not found: ${id}`);
    this.stage(this.snapshotValue.items.map((item, i) => i === index ? applyCalendarItemPatch(item, patch) : item));
  }

  public remove(id: string): void {
    const next = this.snapshotValue.items.filter(item => item.id !== id);
    if (next.length === this.snapshotValue.items.length) throw new Error(`Calendar item not found: ${id}`);
    this.stage(next);
  }

  public replace(items: readonly CalendarItem[]): void {
    this.stage(items);
  }

  public replaceAtRevision(items: readonly CalendarItem[], expectedRevision: number): void {
    if (expectedRevision !== this.snapshotValue.revision) {
      throw new Error(`Staging revision mismatch: expected ${expectedRevision}, found ${this.snapshotValue.revision}`);
    }
    this.stage(items);
  }

  private stage(items: readonly CalendarItem[]): void {
    assertCalendarStateIntegrity(this.snapshotValue.sources, items);
    this.snapshotValue = materializeCalendarSnapshot(
      this.snapshotValue,
      this.snapshotValue.sources,
      items,
      this.snapshotValue.revision,
    );
  }
}

interface HistoryItemChange {
  readonly id: string;
  readonly before?: CalendarItem | undefined;
  readonly after?: CalendarItem | undefined;
}

interface HistoryRun {
  readonly items: readonly CalendarItem[];
  readonly index: number;
  readonly previousUnchangedId?: string | undefined;
  readonly nextUnchangedId?: string | undefined;
}

interface HistoryEntry {
  readonly changes: readonly HistoryItemChange[];
  readonly beforeRuns: readonly HistoryRun[];
  readonly afterRuns: readonly HistoryRun[];
  readonly sourceSignature: string;
}

function sameItem(left: CalendarItem | undefined, right: CalendarItem | undefined): boolean {
  return left === right || (
    left !== undefined
    && right !== undefined
    && JSON.stringify(left) === JSON.stringify(right)
  );
}

function sourceSignature(sources: readonly CalendarSource[]): string {
  return JSON.stringify(sources);
}

function changedItemIds(
  before: readonly CalendarItem[],
  after: readonly CalendarItem[],
): readonly string[] {
  const beforeById = new Map(before.map(item => [item.id, item] as const));
  const afterById = new Map(after.map(item => [item.id, item] as const));
  const ids: string[] = [];
  for (const item of before) {
    if (!sameItem(item, afterById.get(item.id))) ids.push(item.id);
  }
  for (const item of after) {
    if (!beforeById.has(item.id)) ids.push(item.id);
  }
  return ids;
}

function historyRuns(
  items: readonly CalendarItem[],
  affectedIds: ReadonlySet<string>,
): readonly HistoryRun[] {
  const runs: HistoryRun[] = [];
  let index = 0;
  while (index < items.length) {
    if (!affectedIds.has(items[index]!.id)) {
      index += 1;
      continue;
    }
    const start = index;
    const runItems: CalendarItem[] = [];
    while (index < items.length && affectedIds.has(items[index]!.id)) {
      runItems.push(items[index]!);
      index += 1;
    }
    const previous = start > 0 ? items[start - 1] : undefined;
    const next = index < items.length ? items[index] : undefined;
    runs.push(Object.freeze({
      items: Object.freeze(runItems),
      index: start,
      ...(previous ? { previousUnchangedId: previous.id } : {}),
      ...(next ? { nextUnchangedId: next.id } : {}),
    }));
  }
  return Object.freeze(runs);
}

function buildHistoryEntry(
  before: readonly CalendarItem[],
  after: readonly CalendarItem[],
  sources: readonly CalendarSource[],
): HistoryEntry | undefined {
  const ids = changedItemIds(before, after);
  if (!ids.length) return undefined;
  const affectedIds = new Set(ids);
  const beforeById = new Map(before.map(item => [item.id, item] as const));
  const afterById = new Map(after.map(item => [item.id, item] as const));
  return Object.freeze({
    changes: Object.freeze(ids.map(id => Object.freeze({
      id,
      ...(beforeById.has(id) ? { before: beforeById.get(id)! } : {}),
      ...(afterById.has(id) ? { after: afterById.get(id)! } : {}),
    }))),
    beforeRuns: historyRuns(before, affectedIds),
    afterRuns: historyRuns(after, affectedIds),
    sourceSignature: sourceSignature(sources),
  });
}

function insertHistoryRun(next: CalendarItem[], run: HistoryRun, label: string): void {
  const previousIndex = run.previousUnchangedId === undefined
    ? -1
    : next.findIndex(item => item.id === run.previousUnchangedId);
  const followingIndex = run.nextUnchangedId === undefined
    ? -1
    : next.findIndex(item => item.id === run.nextUnchangedId);

  if (run.previousUnchangedId !== undefined && run.nextUnchangedId !== undefined) {
    if (previousIndex < 0 && followingIndex < 0) {
      throw new Error(`Calendar order changed around ${label}; refusing to guess item placement`);
    }
    if (previousIndex >= 0 && followingIndex >= 0 && previousIndex >= followingIndex) {
      throw new Error(`Calendar order changed around ${label}; refusing to reorder unrelated items`);
    }
  }

  let insertionIndex: number;
  if (previousIndex >= 0) insertionIndex = previousIndex + 1;
  else if (followingIndex >= 0) insertionIndex = followingIndex;
  else if (run.previousUnchangedId !== undefined || run.nextUnchangedId !== undefined) {
    throw new Error(`Calendar order changed around ${label}; refusing to guess item placement`);
  } else insertionIndex = Math.min(run.index, next.length);

  next.splice(insertionIndex, 0, ...run.items);
}

function applyHistoryEntry(
  currentItems: readonly CalendarItem[],
  entry: HistoryEntry,
  direction: "undo" | "redo",
): readonly CalendarItem[] {
  const expectedKey = direction === "undo" ? "after" : "before";
  const runs = direction === "undo" ? entry.beforeRuns : entry.afterRuns;
  const currentById = new Map(currentItems.map(item => [item.id, item] as const));
  const affectedIds = new Set(entry.changes.map(change => change.id));

  for (const change of entry.changes) {
    const expected = change[expectedKey];
    const actual = currentById.get(change.id);
    if (!sameItem(actual, expected)) {
      throw new Error(`Calendar item ${change.id} changed outside ${direction} history; refusing to overwrite newer state`);
    }
  }

  const next = currentItems.filter(item => !affectedIds.has(item.id));
  for (const run of runs) insertHistoryRun(next, run, direction);
  return next;
}

export class RepositoryCommandHandler implements CalendarCommandHandler {
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];

  public constructor(
    private readonly repository: CalendarRepository,
    private readonly historyLimit = 100,
  ) {}

  public historyState(): { readonly canUndo: boolean; readonly canRedo: boolean } {
    return { canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 };
  }

  public async undo(): Promise<boolean> {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    try {
      const current = this.repository.read();
      if (sourceSignature(current.sources) !== entry.sourceSignature) {
        throw new Error("Calendar sources changed outside undo history; refusing to apply an item delta against different source state");
      }
      const next = applyHistoryEntry(current.items, entry, "undo");
      assertCalendarStateIntegrity(current.sources, next);
      await this.repository.replaceAtRevision(next, current.revision);
      this.redoStack.push(entry);
      return true;
    } catch (error) {
      this.undoStack.push(entry);
      throw error;
    }
  }

  public async redo(): Promise<boolean> {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    try {
      const current = this.repository.read();
      if (sourceSignature(current.sources) !== entry.sourceSignature) {
        throw new Error("Calendar sources changed outside redo history; refusing to apply an item delta against different source state");
      }
      const next = applyHistoryEntry(current.items, entry, "redo");
      assertCalendarStateIntegrity(current.sources, next);
      await this.repository.replaceAtRevision(next, current.revision);
      this.undoStack.push(entry);
      return true;
    } catch (error) {
      this.redoStack.push(entry);
      throw error;
    }
  }

  public async execute(command: CalendarCommand, context: CalendarCommandContext): Promise<void> {
    const beforeSnapshot = this.repository.read();
    const staged = new CommandStagingRepository(beforeSnapshot);
    await this.applyCommandToStaging(staged, command, context);
    const stagedItems = staged.read().items;
    if (!changedItemIds(beforeSnapshot.items, stagedItems).length) return;

    // One authoritative repository mutation per logical Calendar command. This makes
    // multi-record operations such as recurrence splitting durable atomically.
    await this.repository.replaceAtRevision(stagedItems, beforeSnapshot.revision);

    const history = buildHistoryEntry(beforeSnapshot.items, stagedItems, beforeSnapshot.sources);
    if (!history) return;
    this.undoStack.push(history);
    if (this.undoStack.length > Math.max(1, this.historyLimit)) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private async applyCommandToStaging(repository: CalendarRepository, command: CalendarCommand, context: CalendarCommandContext): Promise<void> {
    if (command.type === "create") {
      assertSourceAllowsCreate(repository, command.item.calendarId);
      await repository.create(command.item);
      return;
    }
    if (command.type === "update") {
      const item = itemById(repository, command.id);
      assertEditableItem(item);
      assertPatchAllowed(item, command.patch);
      assertPatchSourceAllowed(repository, item, command.patch);
      await repository.update(command.id, command.patch);
      return;
    }
    if (command.type === "remove") {
      const item = itemById(repository, command.id);
      assertEditableItem(item);
      assertSourceMutable(repository, item.calendarId);
      await repository.remove(command.id);
      return;
    }
    if (command.type === "update-occurrence") {
      await applyOccurrencePatch(repository, command.occurrence, command.patch, command.scope, context);
      return;
    }

    assertEditable(command.occurrence);
    const item = itemById(repository, command.occurrence.sourceItemId);
    assertEditableItem(item);
    assertSourceMutable(repository, item.calendarId);
    if (!item.recurrence) {
      if (command.type === "cancel-occurrence") await repository.remove(item.id);
      else await repository.update(item.id, projectTemporalPatchToSeries(item, command.occurrence, movedPatch(command.start, command.end), { timeZone: context.timeZone }));
      return;
    }
    if (command.scope === "all") {
      if (command.type === "cancel-occurrence") await repository.remove(item.id);
      else await repository.update(item.id, seriesPatch(item, command.occurrence, movedPatch(command.start, command.end), context));
      return;
    }

    if (command.scope === "this") {
      const recurrence = command.type === "cancel-occurrence"
        ? withException(item, command.occurrence, null)
        : withException(item, command.occurrence, movedPatch(command.start, command.end));
      await repository.update(item.id, { recurrence });
      return;
    }

    if (command.type === "cancel-occurrence") {
      if (temporalSeriesOrdinal(item, item.recurrence?.rule, command.occurrence.originalStart, { timeZone: context.timeZone }) === 1) {
        await repository.remove(item.id);
        return;
      }
      const first = splitSeries(item, command.occurrence, {}, context)[0]!;
      await repository.update(item.id, { start: first.start, end: first.end, recurrence: first.recurrence ?? null });
      return;
    }

    if (temporalSeriesOrdinal(item, item.recurrence?.rule, command.occurrence.originalStart, { timeZone: context.timeZone }) === 1) {
      await repository.update(item.id, seriesPatch(item, command.occurrence, movedPatch(command.start, command.end), context));
      return;
    }
    const [first, second] = splitSeries(item, command.occurrence, movedPatch(command.start, command.end), context);
    await repository.update(item.id, { start: first!.start, end: first!.end, recurrence: first!.recurrence ?? null });
    await repository.create(second!);
  }
}
