import type {
  CalendarItem,
  CalendarItemId,
  CalendarItemPatch,
  CalendarSource,
  CalendarSourcePatch,
} from "./types.js";

/** Internal immutable state shape used by repository and command-staging transitions. */
export interface CalendarStateCollections {
  readonly sources: readonly CalendarSource[];
  readonly items: readonly CalendarItem[];
}

export function applyCalendarItemPatch(item: CalendarItem, patch: CalendarItemPatch): CalendarItem {
  const description = patch.description === null ? undefined : patch.description ?? item.description;
  const location = patch.location === null ? undefined : patch.location ?? item.location;
  const recurrence = patch.recurrence === null ? undefined : patch.recurrence ?? item.recurrence;
  const temporal = patch.temporal === null ? undefined : patch.temporal ?? item.temporal;
  const display = patch.display === null ? undefined : patch.display ?? item.display;
  const metadata = patch.metadata === null ? undefined : patch.metadata ?? item.metadata;
  const reminders = patch.reminders === null ? undefined : patch.reminders ?? item.reminders;
  return {
    ...item,
    ...(patch.calendarId !== undefined ? { calendarId: patch.calendarId } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(description !== undefined ? { description } : { description: undefined }),
    ...(location !== undefined ? { location } : { location: undefined }),
    ...(patch.start !== undefined ? { start: patch.start } : {}),
    ...(patch.end !== undefined ? { end: patch.end } : {}),
    ...(patch.allDay !== undefined ? { allDay: patch.allDay } : {}),
    ...(patch.precision !== undefined ? { precision: patch.precision } : {}),
    ...(temporal !== undefined ? { temporal } : { temporal: undefined }),
    ...(patch.temporalForm !== undefined ? { temporalForm: patch.temporalForm } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    ...(patch.editPolicy !== undefined ? { editPolicy: patch.editPolicy } : {}),
    ...(recurrence !== undefined ? { recurrence } : { recurrence: undefined }),
    ...(reminders !== undefined ? { reminders } : { reminders: undefined }),
    ...(display !== undefined ? { display } : { display: undefined }),
    ...(metadata !== undefined ? { metadata } : { metadata: undefined }),
  } as CalendarItem;
}

export function applyCalendarSourcePatch(source: CalendarSource, patch: CalendarSourcePatch): CalendarSource {
  const display = patch.display === null ? undefined : patch.display ?? source.display;
  const metadata = patch.metadata === null ? undefined : patch.metadata ?? source.metadata;
  return {
    ...source,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.visible !== undefined ? { visible: patch.visible } : {}),
    ...(display !== undefined ? { display } : { display: undefined }),
    ...(metadata !== undefined ? { metadata } : { metadata: undefined }),
  };
}

export function createCalendarItemInState(
  state: CalendarStateCollections,
  item: CalendarItem,
): CalendarStateCollections {
  if (state.items.some(existing => existing.id === item.id)) throw new Error(`Duplicate calendar item: ${item.id}`);
  if (!state.sources.some(source => source.id === item.calendarId)) throw new Error(`Unknown calendar source: ${item.calendarId}`);
  return { sources: state.sources, items: [...state.items, item] };
}

export function updateCalendarItemInState(
  state: CalendarStateCollections,
  id: CalendarItemId,
  patch: CalendarItemPatch,
): CalendarStateCollections {
  const index = state.items.findIndex(item => item.id === id);
  if (index < 0) throw new Error(`Calendar item not found: ${id}`);
  const updated = applyCalendarItemPatch(state.items[index]!, patch);
  if (!state.sources.some(source => source.id === updated.calendarId)) throw new Error(`Unknown calendar source: ${updated.calendarId}`);
  return {
    sources: state.sources,
    items: state.items.map((item, itemIndex) => itemIndex === index ? updated : item),
  };
}

export function removeCalendarItemFromState(
  state: CalendarStateCollections,
  id: CalendarItemId,
): CalendarStateCollections {
  const items = state.items.filter(item => item.id !== id);
  if (items.length === state.items.length) throw new Error(`Calendar item not found: ${id}`);
  return { sources: state.sources, items };
}

export function createCalendarSourceInState(
  state: CalendarStateCollections,
  source: CalendarSource,
): CalendarStateCollections {
  if (state.sources.some(existing => existing.id === source.id)) throw new Error(`Duplicate calendar source: ${source.id}`);
  return { sources: [...state.sources, source], items: state.items };
}

export function updateCalendarSourceInState(
  state: CalendarStateCollections,
  id: string,
  patch: CalendarSourcePatch,
): CalendarStateCollections {
  const index = state.sources.findIndex(source => source.id === id);
  if (index < 0) throw new Error(`Calendar source not found: ${id}`);
  return {
    sources: state.sources.map((source, sourceIndex) => sourceIndex === index ? applyCalendarSourcePatch(source, patch) : source),
    items: state.items,
  };
}

export function removeCalendarSourceFromState(
  state: CalendarStateCollections,
  id: string,
): CalendarStateCollections {
  const source = state.sources.find(candidate => candidate.id === id);
  if (!source) throw new Error(`Calendar source not found: ${id}`);
  if (source.removable !== true) throw new Error("Calendar source is not removable");
  if (state.items.some(item => item.calendarId === id)) {
    throw new Error("Move or delete events from this calendar before removing it");
  }
  return { sources: state.sources.filter(candidate => candidate.id !== id), items: state.items };
}
