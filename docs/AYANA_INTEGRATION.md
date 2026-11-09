# Ayana Integration Architecture

## Status and purpose

This document defines how Calendar should integrate with Ayana as an embedded submodule/library while preserving Calendar as generic software.

Ayana remains authoritative for journeys, intents, recurrence, recorded moments, money, people, reminders and all other domain state. Calendar provides temporal layout, navigation and calendar interaction mechanics over projected Ayana data.

The governing invariant is:

> Do not copy Ayana records into a Calendar database. Calendar projects Ayana temporal state into calendar occurrences, and every mutation routes back to Ayana's graph/services.

This design is informed by Ayana's current `funny-shannon-2` architecture, where plans, to-dos, preparation, recurring schedules, quota rhythms, habits, payments, reminders, moved/skipped occurrences, arrival triggers, before-leaving work, Everyday intents and recorded moments already share an intent/temporal model.

## Target user experience

The primary first integration is the **Days** surface inside a particular journey.

A selected day should become a Google-Calendar-like schedule without losing Ayana-specific meaning:

```text
Journey: Tokyo
Tuesday · 14 April

ALL DAY
──────────────────────────────────
□ Museum pass
● Staying at Shinjuku Hotel
□ Call airline

08:00 ─────────────────────────────

09:00      Breakfast

10:00 ┌───────────────────────────┐
      │ TeamLab Planets           │
11:30 │ Ana · Toyosu              │
      └───────────────────────────┘

15:00        ◆ ₹12,000 hotel payment due

17:00 ┌───────────────────────────┐
      │ Train to Kyoto            │
19:15 └───────────────────────────┘

──────────────────────────────────
ANYTIME
□ Buy adapter

ON ARRIVAL
□ Message the host
```

Timed plans are duration blocks. Day-only plans/tasks use the all-day lane. Deadlines and payments may be point markers. Anytime, arrival and before-leaving intents retain their own semantics instead of receiving invented clock times.

Calendar is therefore the interaction and geometry engine; Ayana remains the semantic engine.

## Ayana temporal authority

Ayana already owns temporal concepts that Calendar must not duplicate:

- `When`: day, days, clock interval, by-day, by-clock, before-leaving and arrival;
- schedule recurrence versus quota recurrence;
- journey-scoped versus independent recurrence;
- multiple intraday times;
- exceptions, added occurrences and moved occurrences;
- nominal occurrence identity;
- journey temporal bounds;
- completion/kept moments;
- reminders and snoozing;
- task/payment due state;
- arrival-triggered work;
- journey time zones and per-plan zone overrides.

Calendar may consume normalized projections of these concepts but must not reinterpret their domain meaning.

## Required Calendar capability expansion

### 1. Host-expanded occurrence projection

Calendar currently supports projected `CalendarItem` values that its own engine expands.

Ayana needs a second projection boundary for already-expanded host occurrences.

Conceptually:

```ts
interface CalendarOccurrenceProjectionProvider {
  readonly id: string;
  projectOccurrences(range: CalendarRange): Promise<readonly CalendarOccurrence[]> | readonly CalendarOccurrence[];
  subscribe?(listener: () => void): () => void;
}
```

The final API may differ, but the semantics are fixed:

- the host owns recurrence expansion;
- Calendar owns layout and interaction;
- stable source-item and occurrence identities survive projection;
- projected occurrences are integrity-checked;
- Calendar does not expand projected host recurrence again.

This capability is generic and is appropriate for any host with its own scheduler.

### 2. Per-occurrence interaction authority

Ayana temporal objects do not share one edit model.

Examples:

| Ayana temporal object | Move | Resize | Inline state action | Delete/cancel | Recurrence edit |
| --- | ---: | ---: | ---: | ---: | ---: |
| ordinary timed plan | yes | yes | complete | yes | possibly |
| day-only plan | yes | span/date only | complete | yes | possibly |
| to-do deadline | yes | no | complete | yes | possibly |
| payment deadline | yes | no | paid | yes | no |
| scheduled habit occurrence | host-dependent | usually no | keep/unkeep | no | through intent |
| arrival task | no clock drag | no | complete | yes | no |
| before-leaving task | no clock drag | no | complete | yes | no |
| recorded historical moment | normally no | no | host-dependent | host-dependent | no |

Calendar therefore needs a capability provider more precise than the existing item-level `EditPolicy`.

A generic result should independently cover at least:

```text
canMove
canMoveBetweenAllDayAndTimed
canResizeStart
canResizeEnd
canEdit
canDelete
canInvokeInlineActions
canChangeRecurrence
```

The command boundary must revalidate authority; UI state alone is not sufficient enforcement.

### 3. Point/deadline temporal geometry

Calendar currently models duration-bearing items naturally through start/end.

Ayana also contains true point-in-time semantics: task deadlines, payment deadlines and similar milestones.

Calendar should support a generic temporal presentation kind such as:

```text
block
point
all-day
span
background
```

A point occurrence is rendered at its exact time without manufacturing a fake duration.

### 4. Rich structured occurrence presentation

Ayana needs more semantic density than a generic title-only event.

Calendar should retain geometry but permit structured host presentation slots such as:

```text
leading
title
subtitle
trailing
badges
```

Examples:

```text
TeamLab Planets
10:00–11:30
Ana · Toyosu
```

```text
Hotel payment
₹12,000
Due 3 PM
```

```text
○ Meditate
daily rhythm
```

The host may also provide detail rows and safe display metadata. Calendar must not interpret Ayana semantics.

### 5. Inline host actions

Ayana should be able to expose small high-value actions directly in the day surface:

- complete/reopen a task;
- keep/unkeep a recurring occurrence;
- mark a payment paid;
- complete an ordinary plan.

Calendar should expose a generic inline-action contract where identifiers and labels are host-defined and execution routes through the host command/action boundary.

### 6. Recurring occurrence command identity

For an Ayana recurring plan, moving one occurrence must preserve its nominal identity.

Example:

```text
Yoga
Mon/Wed/Fri at 07:00

Wednesday occurrence dragged to 08:00
```

Calendar must route an occurrence-specific move, allowing Ayana to persist:

```text
moves:
  Wed 07:00 → Wed 08:00
```

rather than rewriting the whole recurrence rule.

The same requirement applies to:

- skip/cancel one occurrence;
- move one occurrence;
- edit this occurrence;
- edit this and following;
- edit the complete series.

Calendar command context must therefore support stable host occurrence identity in addition to Calendar's own occurrence identity.

### 7. Timed duration exposure from Ayana

Ayana's current public `ItineraryEvent` projection exposes `startsAt` and optional `endDate`, but does not expose a timed end instant.

The underlying intent graph already supports clock intervals:

```ts
when: {
  type: "clock",
  start,
  end
}
```

For real Google-style blocks and resize interaction, the Ayana adapter must expose that authoritative end time and write resize commands back to the graph.

Calendar must not invent a persisted duration when Ayana does not have one. A temporary creation preview may use a UI default, but saving must produce explicit authoritative temporal state.

### 8. Journey navigation bounds

A journey calendar normally has meaningful date bounds.

Calendar should support optional generic navigation limits:

```ts
navigationBounds?: {
  min?: ISODate;
  max?: ISODate;
}
```

Ayana journey Days may use the journey's first/last day. Everyday and future global calendar surfaces may remain unbounded.

### 9. Embedded/chromeless mode

Ayana already owns the journey header, day ribbon, navigation, sheets and capture bar.

Calendar therefore needs an embedded mode that can suppress Calendar-owned chrome while retaining the requested geometry and interactions.

A granular contract is preferable to one hard-coded mode:

```text
showToolbar
showViewSwitcher
showDateNavigation
showSourceControls
```

Ayana can then embed the day grid without looking like a second application nested inside the first.

### 10. Optional secondary time-zone scale

Travel makes dual-zone display materially useful.

Calendar's primary zone continues to govern geometry, while an optional secondary scale may show another IANA zone:

```text
Tokyo       India
09:00       05:30
10:00       06:30
11:00       07:30
```

This remains generic and optional.

## Ayana adapter boundary

The eventual integration should resemble:

```text
Ayana
│
├── authoritative graph
│   ├── intents
│   ├── moments
│   ├── money
│   ├── journeys
│   └── recurrence
│
├── AyanaCalendarAdapter
│   ├── project journey/day occurrences
│   ├── project Everyday occurrences
│   ├── expose stable host occurrence identities
│   ├── expose per-occurrence capabilities
│   ├── expose presentation and inline actions
│   ├── move occurrences
│   ├── resize plans
│   ├── complete / keep / unkeep / mark paid
│   ├── open Ayana editors
│   └── invalidate Calendar after graph changes
│
└── Calendar
    ├── layout
    ├── day/week/month/year/list views
    ├── drag/drop
    ├── resize
    ├── selection
    ├── keyboard/touch
    ├── navigation
    └── optional interoperability
```

No second IndexedDB repository is required for Ayana-owned state.

## Creation flow

Creating in an empty time slot should not cause Calendar to persist an independent item.

The flow should be:

```text
calendar selection
    ↓
Ayana host create callback
    ↓
Ayana editor / capture semantics
    ↓
Ayana graph transaction
    ↓
Ayana invalidates projection
    ↓
Calendar re-queries and displays authoritative occurrence
```

The same rule applies to drag/drop and resize.

## Error, pending and concurrency behavior

Embedded host operations may be asynchronous and may fail due to validation or stale graph revisions.

Calendar should therefore support:

- visible pending state for the affected occurrence/interaction;
- prevention of duplicate commands while pending;
- host validation errors surfaced through Calendar's accessible announcement/error mechanism;
- authoritative refresh after success;
- rollback of visual preview after failure;
- no silent optimistic persistence inside Calendar;
- fail-closed handling when the host record changed after projection.

Ayana's existing graph revision model should remain the concurrency authority.

## Broader Ayana surfaces

After the journey Day integration is stable, the same adapter can support additional surfaces without new domain architecture:

### Journey week

Useful for longer trips and comparing adjacent days. The same journey-bound projection is used with a wider range.

### Journey month

Useful for extended travel, long stays and planning before departure. All-day spans, recurring plans and deadlines become more important than minute-level detail.

### Everyday calendar

Projects ownerless Ayana intents and planned money outside journeys. No journey date bounds apply.

### Global Ayana calendar

A later aggregate surface may combine:

- multiple journeys;
- Everyday intents;
- payments/deadlines;
- optionally external calendar overlays.

This should be a projection composition problem, not a new persistence model.

### External calendar integration

Calendar already contains ICS and Google Calendar interoperability. Ayana integration should initially keep these optional.

If enabled later:

- Ayana remains authoritative for Ayana records;
- external identifiers remain interoperability metadata;
- sync must not flatten Ayana-only semantics into Calendar core;
- unsupported Ayana semantics must have explicit export policies rather than silent loss.

## Explicit non-goals

Calendar core must not gain concepts named:

- journey;
- packing;
- people met;
- payment;
- habit;
- intention;
- preparation;
- arrival;
- side trip;
- recorded moment;
- Everyday;
- journal.

Those meanings stay in Ayana and its adapter.

Calendar also does not replace Ayana's recurrence engine.

## Existing Calendar capabilities to reuse

The integration should build on existing Calendar functionality rather than reproduce it:

- day/week/month/year views;
- agenda/list ranges;
- all-day lane;
- timed-grid geometry;
- current-time indicator;
- mouse/touch drag-and-drop;
- cross-day movement;
- dual-edge resize;
- selection-drag creation;
- snapping and collision policy;
- keyboard movement/resizing;
- recurrence UI for Calendar-owned records;
- timezone-aware and DST-safe movement;
- month overflow;
- reminder contracts;
- host command handler;
- host callbacks/extensions;
- ICS and Google interoperability.

The next Calendar programme is therefore a **host-integration expansion**, not another calendar rewrite.
