# Ayana Host-Integration Implementation Programme

## Objective

Extend Calendar so it can serve as a Google-Calendar-like embedded temporal surface for Ayana and other hosts with authoritative scheduling domains, without moving host semantics or persistence into Calendar core.

The programme is intentionally split between:

1. generic Calendar capabilities that benefit multiple hosts;
2. an Ayana adapter that translates Ayana's graph into those capabilities;
3. Ayana UI integration.

Each phase follows:

**audit → objectives → implementation → objective verification → targeted QA**

Broad QA is required after the Calendar-side generic expansion and again after end-to-end Ayana integration.

---

## Phase C1 — Host-expanded occurrence projection

### Objective

Allow a host to supply already-expanded occurrences for a requested range.

### Calendar work

- define a generic occurrence-projection provider;
- support provider invalidation subscriptions;
- combine item projections and host-expanded occurrence projections safely;
- integrity-check source IDs, occurrence IDs, source-item IDs and chronology;
- prevent Calendar recurrence expansion from being applied twice;
- preserve current item-projection behavior unchanged.

### Acceptance gate

- a host can project recurring occurrences that Calendar does not understand semantically;
- Calendar renders only what the provider returns;
- duplicate or malformed projected identities fail closed;
- range changes cause bounded re-projection;
- existing Calendar item recurrence behavior is unchanged.

### Targeted QA

- host-expanded recurring occurrences;
- duplicate occurrence identity;
- invalid source references;
- provider invalidation;
- mixed item + occurrence projections;
- range-bounded queries.

---

## Phase C2 — Per-occurrence interaction capabilities

### Objective

Replace coarse UI assumptions with explicit operation-level authority while retaining `EditPolicy` as a fail-closed baseline.

### Calendar work

Introduce a capability provider that can independently determine whether an occurrence may:

- move;
- move between all-day and timed placement;
- resize its start;
- resize its end;
- open/edit;
- delete/cancel;
- change recurrence;
- invoke inline host actions.

The command path must revalidate capabilities at execution time.

### Acceptance gate

- readonly/generated behavior remains fail closed;
- existing `full` and `schedule-only` consumers require no rewrite;
- host capability restrictions can only narrow authority unless an explicit trusted host command path is used;
- drag handles, keyboard hints and context actions reflect actual authority.

### Targeted QA

- asymmetric resize authority;
- movable but not editable occurrence;
- editable but not movable occurrence;
- capability change between projection and execution;
- source-level readonly combined with host capability.

---

## Phase C3 — Point/deadline temporal layout

### Objective

Represent true point-in-time temporal values without fake durations.

### Calendar work

- add generic temporal presentation/layout semantics;
- implement point-marker geometry in day/week time grids;
- include point values in agenda/month/year presentation;
- define collision behavior without treating point markers as duration blocks;
- make point markers keyboard- and screen-reader-accessible.

### Acceptance gate

A 15:00 deadline can be rendered exactly at 15:00 without storing or implying a 30/60-minute duration.

### Targeted QA

- multiple point markers at the same time;
- point marker beside a duration block;
- all-day/point conversion restrictions;
- narrow-screen layout;
- agenda ordering.

---

## Phase C4 — Structured host presentation and inline actions

### Objective

Allow hosts to add semantic richness while Calendar retains layout ownership.

### Calendar work

Add structured presentation hooks for:

- leading content;
- title;
- subtitle;
- trailing content;
- badges;
- existing detail metadata.

Add generic inline host actions with:

- stable action ID;
- label;
- optional state/pressed state;
- enabled/pending state;
- accessible label;
- host execution callback.

Avoid arbitrary unbounded DOM ownership if structured presentation is sufficient.

### Acceptance gate

A host can render an occurrence like:

```text
TeamLab Planets
Ana · Toyosu
10:00–11:30
```

and expose a small action such as Complete/Keep/Paid without Calendar knowing those semantics.

### Targeted QA

- structured content escaping;
- multiple badges;
- inline action click versus event open/drag;
- pending action state;
- failed host action;
- keyboard operation.

---

## Phase C5 — Embedded mode and navigation bounds

### Objective

Allow Calendar to sit naturally inside another application shell.

### Calendar work

Add independently configurable Calendar chrome:

- toolbar;
- date navigation;
- view switcher;
- source controls;
- create controls where relevant.

Add optional navigation bounds:

- minimum date;
- maximum date.

Bounds apply consistently to:

- previous/next navigation;
- jump-to-date;
- keyboard date navigation;
- drag across range boundaries.

### Acceptance gate

A host can render only the day grid inside its own page and confine navigation to a supplied date range.

### Targeted QA

- one-day journey;
- bounded first/last day;
- hidden toolbar with keyboard navigation;
- out-of-range drag;
- programmatic anchor updates.

---

## Phase C6 — Host command lifecycle

### Objective

Make Calendar robust when the authoritative host is asynchronous, revisioned and capable of rejecting changes.

### Calendar work

- occurrence-level pending state;
- duplicate-command suppression;
- accessible host error surfacing;
- authoritative refresh after command completion;
- preview rollback on failure;
- stable command context carrying host occurrence identity and requested series scope;
- no Calendar-side persistence for host-owned projected occurrences.

### Acceptance gate

A stale or rejected host command leaves Calendar visually and semantically consistent with the host.

### Targeted QA

- delayed host mutation;
- rejected move;
- rejected resize;
- stale revision;
- host invalidation during pending operation;
- repeated click/drag suppression.

---

## Phase C7 — Optional secondary time-zone scale

### Objective

Support travel/distributed-work contexts without changing primary geometry.

### Calendar work

- optional secondary IANA zone;
- dual time labels in day/week grid;
- DST-safe label conversion;
- no change to event identity or command semantics.

### Acceptance gate

The same time grid can display the primary journey zone and one secondary reference zone without affecting scheduling.

### Targeted QA

- half-hour offsets;
- DST transition;
- zones on different civil dates;
- hidden/visible secondary scale.

---

# Ayana-side programme

Calendar generic expansion should be completed and released before Ayana integration work begins.

## Phase A1 — Authoritative temporal projection audit

### Objective

Create one documented mapping from Ayana graph records to calendar occurrences.

### Ayana work

Map at least:

- ordinary itinerary plans;
- multi-day plans;
- timed clock intervals;
- day-only plans;
- tasks/by-day/by-clock deadlines;
- planned payments;
- repeating schedule occurrences;
- habits/rhythms that should appear on the calendar;
- arrival/before-leaving/anytime intents;
- completion/kept state;
- per-plan and journey time zones.

Define explicit exclusions rather than projecting everything.

### Gate

Every projected visual object has exactly one authoritative Ayana record/occurrence identity.

---

## Phase A2 — Expose timed end values

### Objective

Make timed blocks and resizing real.

### Ayana work

- expose `when.type === "clock"` end values through the application projection;
- retain true civil-zone semantics;
- permit update of start/end through an application service;
- validate positive intervals and journey/domain rules.

Do not invent persisted durations for records that genuinely have only a point time.

### Gate

A timed Ayana plan with an explicit end round-trips through Calendar without losing either endpoint.

---

## Phase A3 — AyanaCalendarAdapter

### Objective

Implement the sole integration boundary between Ayana and Calendar.

### Responsibilities

- project journey occurrences for a requested range;
- later project Everyday/global ranges;
- map Ayana IDs and nominal recurrence IDs to stable Calendar host identities;
- provide interaction capabilities per occurrence;
- provide structured presentation;
- provide inline actions;
- translate Calendar move/resize/create/delete/series commands into Ayana services;
- trigger Calendar invalidation after graph changes;
- open existing Ayana sheets/editors when semantic editing is requested.

### Gate

Calendar has no direct dependency on Ayana repositories or graph internals beyond this adapter contract.

---

## Phase A4 — Journey Days integration

### Objective

Replace or augment the current list-oriented journey Days temporal surface with the embedded calendar day grid.

### Initial experience

- retain Ayana journey header and day ribbon;
- embed Calendar in day mode with Calendar chrome suppressed;
- journey date bounds constrain navigation;
- current-day indicator uses journey time zone;
- timed plans are blocks;
- all-day plans/tasks use the all-day lane;
- deadlines/payments use point markers;
- anytime/arrival/before-leaving items remain in Ayana-owned companion sections;
- tapping an occurrence opens the existing Ayana editor;
- drag/drop and resize route through the adapter;
- inline actions preserve Ayana completion/keep/paid behavior.

### Gate

No duplicate Ayana state exists in Calendar storage.

---

## Phase A5 — Journey recurrence interaction

### Objective

Make moved/skipped recurring occurrences behave exactly like Ayana recurrence semantics.

### Ayana work

- preserve nominal occurrence identity in Calendar projection;
- map single-occurrence moves to Ayana `moves`;
- map skip/cancel to the appropriate Ayana recurrence exception;
- keep/complete the correct nominal occurrence;
- define support for this/following/all where Ayana semantics permit it.

### Gate

Moving Wednesday's 07:00 recurring plan to 08:00 changes only that intended occurrence unless a wider scope was explicitly chosen.

---

## Phase A6 — Creation flows

### Objective

Use calendar selection as an Ayana-native creation affordance.

### Flow

```text
drag/click empty time
→ Calendar selection
→ Ayana create callback
→ existing/new Ayana plan editor
→ graph transaction
→ projection invalidation
→ Calendar refresh
```

The host decides whether a selection creates:

- a plan;
- a task;
- another supported intent.

Calendar does not guess Ayana semantics.

### Gate

Canceling the Ayana editor creates nothing; saving creates one authoritative Ayana graph action.

---

## Phase A7 — Broader Ayana calendar surfaces

Only after journey Day is stable:

1. **Journey week view** for longer trips.
2. **Journey month view** for extended travel and planning.
3. **Everyday calendar** for ownerless intents and planned money.
4. **Global Ayana calendar** composing multiple journeys + Everyday.
5. Optional external overlays from Google/ICS.

These reuse the same adapter architecture; they must not create parallel persistence paths.

---

## Phase A8 — External interoperability policy

Google/ICS integration is optional and later.

Before enabling two-way sync, define explicitly:

- which Ayana kinds may export;
- which fields round-trip;
- which Ayana semantics are intentionally not exported;
- ownership/conflict rules;
- how external edits map back to Ayana;
- how recurrence mismatches are handled;
- what happens to unsupported arrival/quota/journey-bound semantics.

No silent semantic loss.

---

# QA strategy

## Calendar generic QA

Normal QA remains non-screenshot:

- strict TypeScript;
- focused unit/integration tests;
- package export/import checks;
- affected existing regression suites.

Browser visual QA remains explicit rather than routine.

## Ayana adapter QA

Use authentic Ayana domain fixtures and graph writes, not only synthetic Calendar items.

Minimum journeys:

- ordinary timed day;
- multi-day plan;
- DST/time-zone change;
- recurring moved/skipped occurrence;
- task deadline;
- payment deadline;
- arrival trigger;
- quota rhythm;
- side trip;
- Everyday item.

## End-to-end acceptance journeys

At minimum:

1. create a timed plan from empty grid space;
2. move it within a day;
3. move it to another journey day;
4. resize both edges;
5. move an all-day plan into timed placement where allowed;
6. complete/reopen through an inline action;
7. mark a payment paid;
8. move one recurring occurrence without changing the series;
9. provoke a stale-revision rejection and verify rollback;
10. cross a DST boundary without wall-time corruption.

---

# Programme completion criteria

The integration is complete only when:

- Calendar core contains no Ayana semantic imports or branches;
- Ayana persists all Ayana state;
- Calendar may be removed/replaced without data migration;
- the Ayana adapter is the only translation boundary;
- every calendar mutation passes through Ayana authority;
- Google-like day interactions work for the temporal types that genuinely support them;
- non-clock semantics remain truthful rather than being forced into fake appointments;
- accessibility, touch, keyboard and narrow-screen interaction remain functional;
- targeted and broad QA pass.
