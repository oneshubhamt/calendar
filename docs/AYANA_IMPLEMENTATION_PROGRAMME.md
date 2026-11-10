# Ayana Host-Integration Implementation Programme

## Status

Calendar-side generic capability work is complete and has been consolidated into the current-state architecture contract. Historical C1–C11 implementation sequencing is intentionally not retained here; Git history records that work.

# Ayana-side programme

Calendar's generic prerequisites are complete. The authoritative current Calendar contracts are in `ARCHITECTURE.md`; `AYANA_INTEGRATION.md` defines the host boundary and target experience. This programme now tracks only Ayana-side integration work.

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
- Calendar may be removed/replaced without affecting authoritative Ayana data;
- the Ayana adapter is the only translation boundary;
- every calendar mutation passes through Ayana authority;
- Google-like day interactions work for the temporal types that genuinely support them;
- non-clock semantics remain truthful rather than being forced into fake appointments;
- accessibility, touch, keyboard and narrow-screen interaction remain functional;
- targeted and broad QA pass.

