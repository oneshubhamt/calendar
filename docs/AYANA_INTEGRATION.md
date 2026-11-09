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

The implemented Calendar contract is:

```ts
interface CalendarOccurrenceProjectionProvider {
  readonly id: string;
  projectOccurrences(range: CalendarRange): Promise<readonly CalendarOccurrence[]> | readonly CalendarOccurrence[];
  subscribe?(listener: () => void): () => void;
}

new CalendarEngine(repository, itemProjections?, occurrenceProjections?)
```

A projected occurrence carries a stable `occurrenceId`, a stable `sourceItemId`, and may carry an opaque `projectionIdentity` containing bounded JSON-like provider identity data. It does not duplicate source identity as an item `id`. `start`, `end` and `originalStart` at this already-expanded boundary must be absolute ISO date-times; Calendar canonicalizes offsets and rejects date-only/floating occurrence boundaries before range filtering. Calendar does not interpret `projectionIdentity`; an Ayana adapter may therefore preserve whatever recurrence key it needs without adding an Ayana-specific field to generic Calendar types.

The semantics are:

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

Calendar now exposes `CalendarOccurrenceCapabilityProvider`, with generic flags for `canMove`, `canMoveBetweenAllDayAndTimed`, `canResizeStart`, `canResizeEnd`, `canOpen`, `canEdit`, `canDelete`, `canInvokeActions` and `canChangeRecurrence`.

Normal/default-path capability results can only narrow `EditPolicy` plus source authority. For authoritative host occurrences, the adapter may select `commandPath: "trusted-host"`; explicitly granted operations then route through `trustedHostCommandHandler` instead of Calendar persistence. Execution resolves the provider again, so UI state alone is not the enforcement boundary. Editor saves and add-on patches also classify the actual temporal mutation before dispatch: movement, individual endpoint resize and all-day/timed conversion therefore cannot be smuggled through a broader `canEdit` grant.

### 3. Point/deadline temporal geometry

Calendar now supports true point-in-time values generically through `temporalForm: "point"`. The representation is deliberately domain-neutral: a point requires `start === end`, cannot be all-day/date-only, and carries no Calendar meaning such as deadline, payment or milestone. Omitted/`interval` values preserve existing duration behavior.

For an Ayana adapter, a host-expanded deadline-like occurrence can therefore project its authoritative instant directly:

```ts
{
  start: "2026-04-14T15:00:00.000Z",
  end: "2026-04-14T15:00:00.000Z",
  temporalForm: "point"
}
```

Calendar range-bounds the marker by that instant, renders it at the exact time in day/week grids, includes it in month/year/agenda surfaces, and gives simultaneous temporal collisions independent columns. Distinct nearby point markers that would overlap only in screen pixels use visual-only lanes; this never creates fake scheduling duration or collision. Point markers cannot be resized or converted to all-day placement through Calendar mechanics. The built-in editor treats the point as one editable instant and always preserves `start === end`; movement likewise preserves zero duration and routes through the per-occurrence authority/host-command boundary.

### 4. Rich structured occurrence presentation

Ayana needs more semantic density than a generic title-only event.

Calendar now retains geometry while permitting structured host presentation through `CalendarOccurrencePresentation`:

```text
icon
leading
title
subtitle
trailing
badges
accessibleLabel
```

These slots are deliberately text-only (`string` or `CalendarPresentationText`) so an Ayana adapter can provide semantic density without taking ownership of Calendar DOM/layout. `accessibleLabel` may replace the complete accessible label for the Calendar-owned primary occurrence target. The structured `icon` overrides ordinary display-icon fallback for that occurrence. Existing `detailRows`, agenda metadata and safe style metadata remain available; malformed dataset keys are ignored before DOM assignment.

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

Calendar exposes this through the existing `CalendarSourceActionPort`. An action may opt into `inline: true` and provide a safe text `icon`, accessible label, generic `state`, `pressed`, `enabled` and `pending` values, plus `primary`/`danger` presentation metadata. Calendar renders the control and owns its interaction isolation; the opaque action ID is revalidated at execution and `execute(actionId, occurrence)` remains the host callback. Existing non-inline source actions continue to work unchanged in detail/context surfaces, using the same action-state renderer without breaking menu keyboard navigation.

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

Calendar now supports optional generic navigation limits:

```ts
navigationBounds?: {
  min?: ISODate;
  max?: ISODate;
}
```

The dates are inclusive in Calendar's configured display zone. Invalid/reversed bounds fail closed. Initial/programmatic anchors clamp into the range; previous/next, Jump and keyboard navigation cannot leave it; projection/collision queries are intersected with it; and all Calendar placement paths reject create/move/resize results that cross it. Week/month/year geometry may still show surrounding dates, but those cells are non-interactive and host occurrences are not projected into them.

Ayana journey Days may use the journey's first/last day. Everyday and future global calendar surfaces may remain unbounded.

### 9. Embedded/chromeless mode

Ayana already owns the journey header, day ribbon, navigation, sheets and capture bar.

Calendar therefore needs an embedded mode that can suppress Calendar-owned chrome while retaining the requested geometry and interactions.

The implemented contract is granular rather than one hard-coded mode:

```ts
chrome?: {
  toolbar?: boolean;
  dateNavigation?: boolean;
  viewSwitcher?: boolean;
  sourceControls?: boolean;
  createControls?: boolean;
}
```

All controls default to visible. `toolbar: false` omits the Calendar-owned toolbar entirely; the remaining flags independently suppress their respective controls when the toolbar is present. Hiding chrome does not disable keyboard navigation, grid interaction or host callbacks. Ayana can therefore embed only the day grid without looking like a second application nested inside the first.

### 10. Optional secondary time-zone scale

Travel makes dual-zone display materially useful.

Calendar's primary zone continues to govern geometry, while `CalendarUiOptions.secondaryTimeZone` may show one validated secondary IANA reference scale in day/week views:

```ts
new CalendarUi(host, engine, {
  timeZone: "Asia/Tokyo",
  secondaryTimeZone: "Asia/Kolkata",
});
```

```text
Tokyo       India
09:00       05:30
10:00       06:30
11:00       07:30
```

The primary grid and all wall-clock hit-testing use the same civil-timeline mapping rather than elapsed milliseconds from midnight. Primary events therefore stay aligned with displayed wall time; nonexistent spring-forward minutes are non-targetable rather than silently shifted, and repeated fall-back minutes target the explicit `dstOverlapDisambiguation` policy (`earlier` or `later`). The built-in editor uses the same rule. The reference scale resolves primary civil hours against IANA rules: half-hour offsets remain exact, gaps are explicit, overlaps expose both secondary values, visible-week offset changes remain distinct, and previous/next civil-date values are marked `-1d`/`+1d`. The secondary zone never enters projection queries, occurrence identity or command context.

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

Calendar now provides this lifecycle generically: pending state records the specific operation while retaining one-command-at-a-time suppression per occurrence, is visible through `aria-busy`/pending-operation state, and survives host invalidation/re-render. Tentative geometry is stateful rather than attached only to the current DOM node, so an intermediate reprojection can reconstruct it while the command remains unresolved. Capability authority is revalidated immediately before execution; host errors use Calendar's accessible announcement channel; and the visible range refreshes after both success and rejection. A host mutation rejection is distinct from `committed-refresh-failed`: after commit, a failed reprojection is announced as a refresh problem and must not encourage a duplicate retry. Trusted hosts may use `CalendarCommandStaleError` for explicit revision/stale rejection, and the trusted-host path never falls back to Calendar persistence. Stable command context carries `occurrenceId`, `sourceItemId`, opaque `projectionIdentity` and requested `seriesScope`.

Ayana's existing graph revision model remains the concurrency authority; stale revisions should be rejected by the adapter/service and Calendar will re-query instead of overwriting newer host state.

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
