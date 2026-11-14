export function makePersonalSource(overrides = {}) {
  return { id: "personal", title: "Personal", visible: true, sourceType: "personal", ...overrides };
}

export function makeCalendarItem(overrides = {}) {
  return {
    id: "e1",
    calendarId: "personal",
    title: "Event",
    start: "2026-03-01T14:00:00.000Z",
    end: "2026-03-01T15:00:00.000Z",
    kind: "event",
    ownership: "calendar",
    editPolicy: "full",
    ...overrides,
  };
}

export function makeResourceOccurrence(overrides = {}) {
  return {
    occurrenceId: "occ",
    sourceItemId: "item",
    calendarId: "calendar",
    title: "Visit",
    start: "2026-11-10T09:00:00.000Z",
    end: "2026-11-10T10:00:00.000Z",
    originalStart: "2026-11-10T09:00:00.000Z",
    recurring: false,
    kind: "event",
    ownership: "host",
    editPolicy: "full",
    ...overrides,
  };
}
