import type {
  CalendarCommand,
  CalendarCommandContext,
  CalendarCommandHandler,
  CalendarItem,
  CalendarItemPatch,
  CalendarOccurrence,
  CalendarRecurrence,
  CalendarRepository,
  CalendarSource,
  RecurrenceException,
} from "./types.js";
import { projectTemporalPatchToSeries, rebaseTemporalSeriesExceptions, sameRecurrence, temporalSeriesIdentityAtOrdinal, temporalSeriesOrdinal } from "./recurrence.js";
import { applyCalendarItemPatch, assertCalendarStateIntegrity } from "./store.js";

/** Host/repository command rejection caused by an obsolete authoritative revision. */
export class CalendarCommandStaleError extends Error {
  public readonly code = "stale" as const;

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
 * Command-local mutable staging repository. It preserves references to unchanged
 * immutable snapshot entities and never publishes notifications or durable writes.
 * RepositoryCommandHandler commits its final item set once through replace().
 */
class CommandStagingRepository implements CalendarRepository {
  private items: CalendarItem[];

  public constructor(
    private readonly sources: readonly CalendarSource[],
    initialItems: readonly CalendarItem[],
    private readonly revision: number,
  ) {
    this.items = [...initialItems];
  }

  public read() {
    return { sources: this.sources, items: this.items, revision: this.revision };
  }

  public create(item: CalendarItem): void {
    const next = [...this.items, item];
    assertCalendarStateIntegrity(this.sources, next);
    this.items = next;
  }

  public update(id: string, patch: CalendarItemPatch): void {
    const index = this.items.findIndex(item => item.id === id);
    if (index < 0) throw new Error(`Calendar item not found: ${id}`);
    const next = this.items.map((item, i) => i === index ? applyCalendarItemPatch(item, patch) : item);
    assertCalendarStateIntegrity(this.sources, next);
    this.items = next;
  }

  public remove(id: string): void {
    const next = this.items.filter(item => item.id !== id);
    if (next.length === this.items.length) throw new Error(`Calendar item not found: ${id}`);
    assertCalendarStateIntegrity(this.sources, next);
    this.items = next;
  }

  public replace(items: readonly CalendarItem[]): void {
    assertCalendarStateIntegrity(this.sources, items);
    this.items = [...items];
  }
}

interface HistoryEntry {
  readonly before: readonly CalendarItem[];
  readonly after: readonly CalendarItem[];
  readonly sources: readonly CalendarSource[];
}

function cloneItems(items: readonly CalendarItem[]): readonly CalendarItem[] {
  return items.map(item => structuredClone(item));
}

function cloneSources(sources: readonly CalendarSource[]): readonly CalendarSource[] {
  return sources.map(source => structuredClone(source));
}

function sameItems(a: readonly CalendarItem[], b: readonly CalendarItem[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameSources(a: readonly CalendarSource[], b: readonly CalendarSource[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
      if (!sameItems(current.items, entry.after) || !sameSources(current.sources, entry.sources)) throw new Error("Calendar changed outside undo history; refusing to overwrite newer state");
      await this.repository.replace(cloneItems(entry.before));
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
      if (!sameItems(current.items, entry.before) || !sameSources(current.sources, entry.sources)) throw new Error("Calendar changed outside redo history; refusing to overwrite newer state");
      await this.repository.replace(cloneItems(entry.after));
      this.undoStack.push(entry);
      return true;
    } catch (error) {
      this.redoStack.push(entry);
      throw error;
    }
  }

  public async execute(command: CalendarCommand, context: CalendarCommandContext): Promise<void> {
    const beforeSnapshot = this.repository.read();
    const staged = new CommandStagingRepository(beforeSnapshot.sources, beforeSnapshot.items, beforeSnapshot.revision);
    await this.executeAtomic(staged, command, context);
    const stagedItems = staged.read().items;
    if (sameItems(beforeSnapshot.items, stagedItems)) return;

    // One authoritative repository mutation per logical Calendar command. This makes
    // multi-record operations such as recurrence splitting durable atomically.
    await this.repository.replace(stagedItems);

    const afterSnapshot = this.repository.read();
    if (!sameSources(beforeSnapshot.sources, afterSnapshot.sources)) return;
    this.undoStack.push({
      before: cloneItems(beforeSnapshot.items),
      after: cloneItems(afterSnapshot.items),
      sources: cloneSources(afterSnapshot.sources),
    });
    if (this.undoStack.length > Math.max(1, this.historyLimit)) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private async executeAtomic(command: CalendarCommand, context: CalendarCommandContext): Promise<void> {
    if (command.type === "create") {
      assertSourceAllowsCreate(this.repository, command.item.calendarId);
      await this.repository.create(command.item);
      return;
    }
    if (command.type === "update") {
      const item = itemById(this.repository, command.id);
      assertEditableItem(item);
      assertPatchAllowed(item, command.patch);
      assertPatchSourceAllowed(this.repository, item, command.patch);
      await this.repository.update(command.id, command.patch);
      return;
    }
    if (command.type === "remove") {
      const item = itemById(this.repository, command.id);
      assertEditableItem(item);
      assertSourceMutable(this.repository, item.calendarId);
      await this.repository.remove(command.id);
      return;
    }
    if (command.type === "update-occurrence") {
      await applyOccurrencePatch(this.repository, command.occurrence, command.patch, command.scope, context);
      return;
    }

    assertEditable(command.occurrence);
    const item = itemById(this.repository, command.occurrence.sourceItemId);
    assertEditableItem(item);
    assertSourceMutable(this.repository, item.calendarId);
    if (!item.recurrence) {
      if (command.type === "cancel-occurrence") await this.repository.remove(item.id);
      else await this.repository.update(item.id, projectTemporalPatchToSeries(item, command.occurrence, movedPatch(command.start, command.end), { timeZone: context.timeZone }));
      return;
    }
    if (command.scope === "all") {
      if (command.type === "cancel-occurrence") await this.repository.remove(item.id);
      else await this.repository.update(item.id, seriesPatch(item, command.occurrence, movedPatch(command.start, command.end), context));
      return;
    }

    if (command.scope === "this") {
      const recurrence = command.type === "cancel-occurrence"
        ? withException(item, command.occurrence, null)
        : withException(item, command.occurrence, movedPatch(command.start, command.end));
      await this.repository.update(item.id, { recurrence });
      return;
    }

    if (command.type === "cancel-occurrence") {
      if (temporalSeriesOrdinal(item, item.recurrence?.rule, command.occurrence.originalStart, { timeZone: context.timeZone }) === 1) {
        await this.repository.remove(item.id);
        return;
      }
      const first = splitSeries(item, command.occurrence, {}, context)[0]!;
      await this.repository.update(item.id, { start: first.start, end: first.end, recurrence: first.recurrence ?? null });
      return;
    }

    if (temporalSeriesOrdinal(item, item.recurrence?.rule, command.occurrence.originalStart, { timeZone: context.timeZone }) === 1) {
      await this.repository.update(item.id, seriesPatch(item, command.occurrence, movedPatch(command.start, command.end), context));
      return;
    }
    const [first, second] = splitSeries(item, command.occurrence, movedPatch(command.start, command.end), context);
    await this.repository.update(item.id, { start: first!.start, end: first!.end, recurrence: first!.recurrence ?? null });
    await this.repository.create(second!);
  }
}
