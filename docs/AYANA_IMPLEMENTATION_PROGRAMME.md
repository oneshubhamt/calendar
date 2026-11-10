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

**Calendar status: implemented and v1.1 source-closed.** Existing item projection remains intact; already-expanded host occurrences use the separate `CalendarOccurrenceProjectionProvider` boundary and optional opaque `projectionIdentity`. The occurrence boundary now requires absolute `start`, `end` and `originalStart`, canonicalizes offsets before range filtering, and has no redundant item `id`.

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

**Calendar status: implemented and source-closed.** Operation-level authority now resolves through `CalendarOccurrenceCapabilityProvider`; default-path providers only narrow existing policy, while explicit `trusted-host` authority routes through a separate host command handler and may grant selected operations. Editor saves and add-on patches classify their actual temporal mutation and require the same move/resize/conversion capabilities as pointer and keyboard paths.

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

**Status: complete.**

### Objective

Represent true point-in-time temporal values without fake durations.

### Calendar work

- add generic temporal presentation/layout semantics;
- implement point-marker geometry in day/week time grids;
- include point values in agenda/month/year presentation;
- define collision behavior without treating point markers as duration blocks;
- make point markers keyboard- and screen-reader-accessible.

### Implemented contract

`CalendarTemporalForm = "interval" | "point"` is carried by items/occurrences. A point is valid only when `start === end` and remains zero-duration through recurrence, host occurrence projection, editing, duplication, movement, range filtering and layout. The built-in editor exposes one authoritative temporal instant for points and derives `end = start`. Time-grid layout assigns zero-duration geometry at the exact instant; true temporal collisions receive independent collision columns, while nearby non-colliding point markers use separate visual-only lanes when their minimum rendered boxes would otherwise overlap. Month/year/agenda grouping includes points normally. Resize and all-day conversion are unavailable for point geometry, including on the trusted-host command path.

### Acceptance gate

Demonstrated: a 15:00 point renders at 15:00 with zero stored duration and no fabricated 30/60-minute interval.

### Targeted QA

- multiple point markers at the same time;
- point marker beside a duration block;
- all-day/point conversion restrictions;
- narrow-screen layout;
- agenda ordering.

---

## Phase C4 — Structured host presentation

**Calendar status: implemented and v1.1 source-closed.** Calendar retains geometry, interaction and DOM ownership while hosts may supply bounded text-only presentation. Failing presentation hooks are isolated; host data is structurally namespaced as `data-host-*`; host class tokens cannot enter Calendar `dc-*`/`is-*` namespaces; presentation CSS is Calendar-root-scoped and cosmetic-only; add-on CSS is add-on-wrapper-scoped with a conservative responsive `@media` subset. Malformed scope-breaking CSS, geometry declarations on presentation CSS and `!important` fail closed.

### Objective

Allow hosts to add semantic richness without taking ownership of Calendar layout.

### Implemented contract

`CalendarOccurrencePresentation` supports:

- `icon` — optional safe text icon/glyph overriding `CalendarDisplay.icon` for that occurrence presentation;
- `leading`;
- `title`;
- `subtitle`;
- `trailing`;
- `badges`;
- `detailRows` and agenda metadata;
- `accessibleLabel` — a complete occurrence-level accessible-label override;
- safe class/data decoration.

Every structured content slot is text-only (`string` or `CalendarPresentationText`); Calendar never accepts host HTML/DOM. Malformed dataset property names and non-string runtime values are ignored fail-closed before reaching `HTMLElement.dataset`, and reserved prototype keys are rejected. Multiple badges compose while later extensions may override singular presentation slots.

### Acceptance gate

A host can render a dense occurrence such as:

```text
✦ TeamLab Planets
Ana · Toyosu
Reserved
```

with a host-supplied accessible label while Calendar still owns event dimensions, focus, hit testing, drag handles and overflow.

### Targeted QA

- untrusted text is rendered only through text APIs;
- occurrence-level accessible-label override;
- presentation icon override/fallback;
- malformed dataset keys fail closed;
- long subtitles/badge overflow remain Calendar-owned;
- point and duration occurrences use the same structured presentation boundary.

---

## Phase C5 — Generic inline occurrence actions

**Calendar status: implemented and v1.1 source-closed.** Inline actions extend the existing `CalendarSourceActionPort`; there is no second host-action system. The canonical authority flag is `canInvokeActions`, covering inline, detail and context surfaces consistently.

### Objective

Allow high-value host state changes without opening the full editor while keeping action semantics opaque to Calendar.

### Implemented contract

`CalendarSourceAction` keeps stable opaque `id` + `label` and may provide:

- `icon` — safe text glyph;
- `accessibleLabel`;
- `inline` opt-in;
- `enabled` / `pending`;
- `pressed` / `state`;
- `primary` / `danger` presentation metadata;
- open-ended `kind` metadata.

Existing providers remain detail/context-menu actions unless `inline: true` is supplied. Malformed action metadata and duplicate IDs fail closed. Calendar renders native buttons, isolates inline pointer/click/drag/keyboard behavior from occurrence open/drag, revalidates the current action immediately before host execution, and reuses the authoritative occurrence command lifecycle for pending/error/refresh behavior. Context-menu actions use the same rendering state without swallowing the menu's Arrow/Escape keyboard handling.

### Acceptance gate

A host may expose actions such as Complete, Keep or Paid while Calendar knows only an opaque action ID and generic presentation state.

### Targeted QA

- action click versus occurrence open/drag;
- keyboard activation and context-menu navigation;
- asynchronous pending/duplicate suppression;
- rejection + authoritative refresh;
- pressed/state refresh;
- action disappearance after reprojection;
- icon/primary/danger presentation.

---

## Phase C6 — Embedded Calendar mode

**Calendar status: implemented and verified.** Calendar-owned chrome is independently suppressible without disabling the underlying APIs or grid keyboard behavior.

### Objective

Allow Calendar to sit naturally inside another application shell.

### Implemented contract

`CalendarUiOptions.chrome` independently controls:

- `toolbar`;
- `dateNavigation`;
- `viewSwitcher`;
- `sourceControls`;
- `createControls`.

All default to visible. A toolbar-free Calendar no longer depends on a title element to render, and keyboard/date APIs remain available.

### Acceptance gate

A host can render a pure day/week grid or any partial chrome combination without empty toolbar wrappers or hidden API loss.

---

## Phase C7 — Navigation bounds

**Calendar status: implemented and verified.** Inclusive civil-date bounds are enforced beneath toolbar controls as a generic navigation/placement invariant.

### Objective

Support bounded calendars such as trips, projects or courses without embedding those semantics in Calendar.

### Implemented contract

`CalendarUiOptions.navigationBounds` accepts `{ min?, max? }` ISO local dates. Bounds are validated fail-closed and apply to:

- initial/programmatic anchor clamping;
- previous/next/Today/jump navigation;
- keyboard date navigation;
- range selection/creation;
- drag/drop and resize;
- add-on draft placement;
- visible host projection queries;
- collision-check queries.

Surrounding week/month/year cells may remain visible as layout context but are marked non-interactive when outside bounds.

### Acceptance gate

No UI or programmatic mutation path can move/create an occurrence outside the supplied inclusive date range.

---

## Phase C8 — Host command lifecycle hardening

**Calendar status: implemented and source-closed.** Host-owned projected state remains authoritative during asynchronous commands and rejection/concurrency scenarios.

### Objective

Make projected host state safe under slow writes, concurrent revisions and rejection.

### Implemented contract

`CalendarCommandLifecycle` records the actual operation per occurrence (`move`, `resize-start`, `resize-end`, `edit`, action ID, etc.) while suppressing a second concurrent command for the same occurrence. Tentative geometry lives in renderable state rather than a transient DOM node, and lifecycle results distinguish authoritative mutation rejection from `committed-refresh-failed` so callers never retry an operation that may already be committed. Calendar:

- revalidates capability/action authority at execution;
- exposes pending operation state in the rendered occurrence;
- preserves tentative drag/resize geometry while the host command is unresolved;
- refreshes from the authoritative host on success and rejection;
- restores/replaces preview state through authoritative reprojection;
- announces failures accessibly;
- preserves pending state across host invalidation/re-render;
- never falls back to local persistence for the `trusted-host` path.

`CalendarCommandStaleError` is the generic stale/revision failure signal available to trusted hosts.

### Acceptance gate

A rejected or stale host mutation leaves Calendar consistent with the authoritative reprojection, and duplicate commands cannot race one occurrence.

---

## Phase C9 — Host recurrence-command semantics

**Calendar status: implemented and verified.** Calendar's command context is expressive enough for arbitrary host recurrence engines without interpreting their recurrence rules.

### Objective

Preserve the source entity, projected occurrence and requested recurrence scope across host commands.

### Implemented contract

Occurrence commands carry the complete projected occurrence plus stable generic context:

- `sourceItemId`;
- `occurrenceId`;
- occurrence `originalStart`;
- optional opaque `projectionIdentity`;
- `seriesScope: "this" | "this-and-following" | "all"` where applicable.

Calendar's own repository recurrence handling continues unchanged; host-expanded recurrence remains host-owned.

### Acceptance gate

A host can distinguish moving/cancelling one occurrence, this-and-following, and the whole series while retaining its opaque recurrence identity after moved projections.

---

## Phase C10 — Optional secondary time-zone scale

**Calendar status: implemented and source-closed.** One validated secondary IANA reference scale may be added to day/week views without becoming a second scheduling model.

### Objective

Support travel/distributed-work reference time while the primary calendar zone remains authoritative.

### Implemented contract

`CalendarUiOptions.secondaryTimeZone` adds a display-only axis. One shared civil-timeline mapping drives primary timed layout, hit-testing, selection, drag/resize, keyboard wall-time movement, now-line placement and editor resolution. Spring-forward gaps are non-targetable; repeated fall-back minutes obey explicit `dstOverlapDisambiguation`. Secondary labels:

- preserve half-hour/non-whole-hour offsets;
- show spring-forward gaps explicitly;
- expose both values for fall-back overlaps;
- show civil-date rollover with `-1d` / `+1d`;
- retain distinct converted values when offsets vary across a visible week.

Projection queries, grouping, event identity, drag/drop, resizing, persistence and `CalendarCommandContext` continue to use only the primary zone.

### Acceptance gate

Adding/removing the secondary axis changes presentation only and does not alter scheduling semantics.

---

## Phase C11 — Generic Calendar closure audit

**Calendar status: v1.1 generic closure complete.** The current production source—not previous pass claims or historical test counts—must satisfy the gates below. Repository CI installs the pinned Node/npm/TypeScript toolchain, runs strict typecheck, the complete non-visual suite and package dry-run, and verifies the declared package surface through the existing closure tests.

### Closure gates

- no Ayana/domain semantic names in generic `core/` or `view/`;
- item projection and occurrence projection remain separate, with occurrence projections bypassing recurrence expansion;
- occurrence authority has one capability-aware command path and editor/add-on temporal patches use the same mutation classifier;
- baseline `EditPolicy` checks do not bypass trusted-host capability resolution;
- point editing/duplication preserves true zero duration;
- structured presentation/action metadata is bounded and fail-closed where it reaches DOM APIs;
- command lifecycle remains authoritative-host-first;
- secondary time zone remains display-only;
- internal resolver/lifecycle/navigation/time-scale helpers are not unnecessarily exported;
- package export paths build/import successfully;
- docs describe implemented contracts and the C1–C11 numbering accurately;
- full non-screenshot QA and package-content validation pass;
- CI installs and verifies the repository-pinned toolchain before running the quality gate.

For v1.1, the closure additionally requires stable movement-invariant one-off `occurrenceId`, canonical absolute host-occurrence projection, DST-consistent interaction, isolated extension failures, lean production-only npm packaging, and synchronized package/runtime/docs versions. Once these gates pass, v1.1 is the generic Calendar baseline suitable for Ayana adapter integration.

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
- Calendar may be removed/replaced without affecting authoritative Ayana data;
- the Ayana adapter is the only translation boundary;
- every calendar mutation passes through Ayana authority;
- Google-like day interactions work for the temporal types that genuinely support them;
- non-clock semantics remain truthful rather than being forced into fake appointments;
- accessibility, touch, keyboard and narrow-screen interaction remain functional;
- targeted and broad QA pass.
