# Background Ranges & Availability Programme

## Purpose

Director Calendar needs a generic way to show temporal context behind ordinary events: working hours, availability, unavailability, sleep, focus windows, travel windows, blocked periods and similar host-defined ranges.

The governing architectural distinction is:

> **Background ranges are passive temporal visualization. Availability is optional semantic/policy logic that may use background ranges.**

A background range is not an event and does not, by itself, make a time slot legal or illegal for scheduling.

## Architectural invariants

1. **Do not model background ranges as `CalendarItem`s or `CalendarOccurrence`s.** They must never implicitly enter event search, agenda rows, event counts, reminders, recurrence commands, actions, drag/resize authority or event collision layout.
2. **Keep the primitive generic.** Calendar understands resolved temporal ranges and their presentation, not concepts such as work, sleep, office hours or journey availability.
3. **Keep host authority intact.** Hosts may project already-expanded ranges for the requested Calendar range and invalidate them when authoritative host state changes.
4. **Do not create a second recurrence engine.** The core projection boundary consumes already-resolved ranges. Optional features or hosts may expand recurring availability definitions before projection.
5. **Rendering must be passive.** Backgrounds render below selection/events/current-time affordances and must not interfere with hit-testing or interaction.
6. **Scheduling policy is separate.** If later required, availability enforcement belongs in the existing placement-validation pipeline through an explicit guard/policy contract; visual shading alone must never silently block or warn.

## Target layering

```text
host / optional feature
        │
        │ already-expanded temporal ranges
        ▼
CalendarBackgroundProjectionProvider
        │
        ▼
CalendarEngine query + validation
        │
        ▼
background layout / clipping
        │
        ▼
passive background rendering layer

optional availability semantics
        ├── may project background ranges
        └── may later contribute placement policy
```

This mirrors the existing distinction between Calendar-owned item projection and host-owned occurrence projection without turning backgrounds into events.

## View behavior

### Day / Week

These are the primary background-range surfaces. Ranges are positioned against the same civil-time/DST model as timed events, but they never participate in event column clustering.

### Month

Initially show only explicit full-day background ranges. A timed range such as 09:00–17:00 must not become whole-day shading because that would misrepresent its meaning.

### Year

Defer unless a useful, truthful full-day summary is established.

### Agenda

Omit. Background ranges are contextual geometry, not agenda entries.

## Availability remains separate

A range such as 09:00–17:00 could mean either:

- informational working hours; or
- the only period in which scheduling is permitted.

Those meanings must not be inferred from presentation. A later availability feature may provide recurring rules and exceptions and may optionally contribute a placement decision such as `allow`, `warn` or `prevent`. Any such decision should be integrated once into the existing placement-validation path used by create, edit, drag, resize, keyboard transforms and add-ons.

## Programme

### B1 — Core contract and invariants ✅

- add a resolved `CalendarBackgroundRange` contract;
- add `CalendarBackgroundProjectionProvider`;
- require absolute ISO start/end values at this provider boundary;
- require strict positive chronology (`end > start`);
- support stable range identity, optional source association, full-day declaration and bounded opaque metadata;
- canonicalize offsets before downstream processing;
- filter projected ranges to the requested query range and visible associated sources;
- reject duplicate identities and malformed/unknown source associations;
- include background-provider invalidation in `CalendarEngine.subscribe()`;
- expose resolved background ranges alongside occurrences in query results;
- add focused contract/integrity tests.

B1 is complete. It explicitly does **not** implement rendering, recurrence authoring/expansion, availability semantics or placement enforcement.

### B2 — Day/week geometry ✅

- add dedicated background-day geometry;
- reuse the existing civil timeline / DST basis;
- clip cross-midnight and visible-hour boundaries correctly;
- establish deterministic overlap/layer ordering;
- keep event `layoutTimedDay()` unchanged.

B2 is complete through `layoutBackgroundDay()`. Geometry is clipped against the local civil day and optional visible-minute bounds, spring-forward/fall-back behavior follows the existing civil timeline, overlapping ranges remain full-width with deterministic back-to-front `layer` order, and ordinary timed-event layout remains independent.

### B3 — Passive rendering ✅

- add a dedicated background layer inside timed columns;
- keep it below selection, events and the current-time indicator;
- use `pointer-events: none`;
- add safe generic presentation hooks/tokens without exposing Calendar geometry to arbitrary host CSS.

B3 is complete. Day/week timed backgrounds render through a dedicated pointer-transparent z-index-0 layer beneath selection (`1`), events (`2+`) and the current-time marker (`3`). `allDay` background ranges remain deferred to B4. Background color/text/class presentation is cosmetic-only; class tokens use the existing safe host-class gate and extension CSS still cannot claim Calendar geometry. Optional labels are rendered as plain text and do not add interaction handlers.

### B4 — Full-day/month behavior

- support explicit full-day background ranges in month cells;
- keep timed backgrounds out of month shading;
- preserve navigation-bound behavior and accessibility truthfulness.

### B5 — Optional availability semantics

- add an optional, DOM-free availability feature only if a real consumer needs it;
- recurring working/available/unavailable definitions and exceptions may expand into resolved background ranges;
- do not add domain words such as work/sleep/journey to core types.

### B6 — Optional placement guard

- introduce only if scheduling constraints are required;
- route `allow` / `warn` / `prevent` through the existing central placement-validation pipeline;
- cover create, edit, move, resize, keyboard and add-on placement consistently;
- visual ranges remain non-enforcing by default.

### B7 — Targeted QA and architecture audit

Verify at minimum:

- DST gaps and fall-back overlaps;
- cross-midnight ranges;
- overlapping background ranges;
- query range filtering;
- provider invalidation;
- optional source visibility;
- navigation bounds;
- drag/resize/create/keyboard behavior remains unchanged;
- backgrounds never enter collision detection, event layout, agenda, event counts, search, reminders, actions or recurrence commands;
- core/view remain generic and optional features remain removable.

## Completion criterion

The programme is complete only when background ranges are a small generic temporal primitive, availability remains optional policy, and existing event mechanics do not acquire hidden coupling to either concept.
