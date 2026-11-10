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
        └── may explicitly contribute placement policy
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

Those meanings must not be inferred from presentation. The optional availability feature may provide recurring rules and exceptions and may explicitly contribute a placement decision such as `allow`, `warn` or `prevent`. Such decisions are integrated once into the existing placement-validation path used by create, edit, drag, resize, keyboard transforms and add-ons.

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

### B4 — Full-day/month behavior ✅

- support explicit full-day background ranges in month cells;
- keep timed backgrounds out of month shading;
- preserve navigation-bound behavior and accessibility truthfulness.

B4 is complete. Only explicit `allDay: true` background ranges enter day-level rendering. They are grouped across the local days their absolute interval overlaps, rendered as passive full-surface shading in Month cells and Day/Week all-day lanes, omitted entirely on out-of-bounds days, and represented in accessible day/all-day descriptions through bounded label summaries. Timed backgrounds remain excluded from Month/day-level shading. Year and Agenda remain intentionally unsupported for backgrounds.

### B5 — Optional availability semantics ✅

- add an optional, DOM-free availability feature only if a real consumer needs it;
- recurring working/available/unavailable definitions and exceptions may expand into resolved background ranges;
- do not add domain words such as work/sleep/journey to core types.

B5 is complete through the explicit `features/availability` subpath. `CalendarAvailabilityDefinition` supports available/unavailable, timed/all-day, source-associated or global definitions and uses the same generic `RecurrenceRule` machinery as events. Recurrence is implemented at the temporal-series level: availability definitions call `expandTemporalSeries()` directly and never become temporary `CalendarItem` values. Event occurrence mapping is isolated in `core/event-series.ts`, while temporal identity, ordinal, DST/timezone resolution, edit projection and exception rebasing remain generic recurrence mechanics. Availability expansion emits passive background ranges with stable IDs and namespaced `metadata.calendarAvailability`. `createAvailabilityBackgroundProvider()` reads live authoritative definitions and forwards optional invalidation without owning storage. No placement/collision enforcement is introduced.

### B6 — Optional placement guard ✅

- introduce only if scheduling constraints are required;
- route `allow` / `warn` / `prevent` through the existing central placement-validation pipeline;
- cover create, edit, move, resize, keyboard and add-on placement consistently;
- visual ranges remain non-enforcing by default.

B6 is complete. `CalendarPlacementGuard` is a generic core contract with `allow` / `warn` / `prevent` decisions; runtime failures and malformed/duplicate guards fail closed. The reusable headless `evaluateCalendarPlacement()` pipeline now composes navigation bounds, guards and collision policy, invoking a consumer-supplied collision-occurrence loader only when collision evaluation is required. `CalendarUi.allowPlacement()` is a thin view adapter that builds the context, supplies an event-only query and owns confirmation/announcement presentation. Built-in create/duplicate/edit, pointer and native drag/drop moves, resize, keyboard transformations and add-on mutation helpers all pass through that adapter. Custom host `handleCreate` / `handleEdit` callbacks receive a `CalendarPlacementValidationPort` for validating the final draft they own. `features/availability` adds an explicit `createAvailabilityPlacementGuard()` with `exclude-unavailable` and `require-available` policies and configurable `warn` / `prevent` strength. Background providers alone remain purely visual and non-enforcing.

### B7 — Targeted QA and architecture audit ✅

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

B7 is complete after a second de-novo source audit. The audit rechecked B1–B6 source-by-source rather than relying on implementation notes or fixture assertions. Existing behavioral coverage verifies spring-forward gaps, fall-back overlaps, cross-midnight clipping, overlapping background geometry, query filtering, provider invalidation, optional source visibility, navigation bounds and unchanged create/move/resize/keyboard mechanics. Architecture-closure checks verify that background ranges do not enter commands, recurrence, personal search, reminders, occurrence presentation/actions, timed-event layout, Year or Agenda, and that availability remains absent from the root/view dependency graph. The optional availability feature imports core only, remains an explicit package subpath and owns no persistence.

A subsequent recurrence-boundary cleanup also removed the temporary-event adapter used by availability: the canonical recurrence engine now accepts generic temporal series directly, Calendar event occurrence construction is a narrow mapping adapter, and availability has no `CalendarItem` dependency.

The deeper source trace found one genuine coupling missed by the first closure pass: collision validation obtained occurrences through the full engine query, which also invoked passive background providers. A slow, throwing or malformed visual provider could therefore interfere with scheduling validation despite never entering `placementCollisions()`. The engine now supports `includeBackgroundRanges: false`; collision queries use it, and Year/Agenda refreshes also skip passive providers because those views do not render backgrounds. A regression proves that an event-only query does not invoke even a throwing background provider. The audit also removed a duplicated `canPlaceDraft()` declaration from `CalendarUiAddonContext` and corrected stale documentation/dependency wording.

No unresolved in-scope correctness defect remains after those corrections.

## Completion criterion

**Met.** Background ranges are a small generic temporal primitive, availability remains an optional semantic/policy feature, enforcement is explicit rather than inferred from rendering, and existing event mechanics have no hidden dependency on either concept.
