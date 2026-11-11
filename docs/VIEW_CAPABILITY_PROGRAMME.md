# Director Calendar — View Capability Expansion Programme

Baseline: `working` at `0414949a5e5ec29a72a45d2ffb83d9652efedcdc`.

## Purpose

Add five generic calendar capabilities without weakening the existing host-neutral architecture:

1. external drag/drop from arbitrary DOM sources;
2. week numbers;
3. Multi-Month and generic Timeline views;
4. dedicated print styling and print rendering;
5. a generic custom-view plugin API that makes future view additions possible without adding more hard-coded branches to `CalendarUi`.

This programme is an extension of the generic Calendar product, not an Ayana/Director-specific integration programme.

## Governing objectives

The implementation must remain clean, lean, efficient, elegant, robust and reliable.

The programme has the following architectural objectives:

- keep `core/` host- and DOM-neutral;
- keep storage, interoperability and host integrations out of view mechanics;
- preserve the current five built-in views without behavioural regressions;
- avoid turning `calendar-ui.ts` into a larger view switch statement;
- make custom views use Calendar's authoritative interaction/mutation boundaries rather than bypassing them;
- make external drops enter through the same creation, source-authority, placement, collision and item-factory path as ordinary Calendar creation;
- make Multi-Month reuse Month mechanics rather than clone them;
- make generic Timeline reuse a shared horizontal temporal geometry primitive rather than clone Resource Scheduler geometry;
- keep generic Timeline resource-free;
- keep print rendering read-only and free of persistence or command side effects;
- add no runtime dependency or UI framework;
- preserve explicit package boundaries and tree-shakable optional capabilities;
- fail closed on duplicate/invalid view IDs, malformed external drag payloads and unsupported interaction targets;
- add no migration, legacy, compatibility or version-bridging implementation: this is a new application and only the current contract is supported.

No persistence-schema change is expected.

## Architecture decisions

### 1. Custom views become a real view boundary

The existing core `CalendarView` remains the closed type for the current core range helper and the five existing built-in view semantics.

The DOM view layer gains a separate UI-level view identity capable of representing:

- the existing built-in views; and
- explicitly registered custom-view plugin IDs.

This prevents custom-view extensibility from leaking into recurrence, persistence or other core mechanics.

A custom view plugin should declare, at minimum:

- a stable unique ID;
- switcher label;
- visible-range calculation;
- previous/next anchor navigation;
- title generation;
- whether passive background ranges are required;
- DOM rendering against an immutable view context.

Calendar supplies a mutation/action port rather than repository access. The port will expose only operations that can pass through existing Calendar authority and lifecycle logic, such as opening an occurrence, creating from a selection, and requesting occurrence moves/resizes.

Registered custom IDs must not collide with built-in view IDs or with one another.

Multi-Month and Timeline will be the first bundled consumers of this boundary. This is important: the plugin API must be justified and validated by real views rather than created as speculative framework code.

### 2. Bundled advanced views remain optional

Multi-Month and Timeline should be explicit view subpaths rather than mandatory base-view runtime work, provisionally:

- `@director/calendar/view/multi-month`
- `@director/calendar/view/timeline`

The base package remains month/week/day/year/agenda capable without importing either module.

A host opts in by registering the returned view plugins with `CalendarUi`.

### 3. External drop is creation, not an alternate persistence path

External drag/drop creates a new Calendar item. It does not impersonate internal occurrence dragging.

The supported flow is:

```text
arbitrary DOM drag source
        ↓
bounded/synchronous DataTransfer decode
        ↓
Calendar drop target → CalendarSelection
        ↓
external-drop draft/template resolution
        ↓
normal Calendar createDraft/itemFactory path
        ↓
source authority + navigation bounds
        ↓
placement guards + collision policy
        ↓
normal command/host mutation path
```

A Calendar-defined MIME helper should exist for the common case, while hosts may provide a decoder for their own drag formats.

DataTransfer must be decoded synchronously while the browser still owns the drag event. Any later asynchronous work operates on an owned decoded value, never on a retained DataTransfer object.

### 4. Week numbering is a temporal primitive, not a renderer hack

Core gains a pure week-year/week-number calculation parameterized by:

- displayed week start; and
- minimum days required in the first week of a year.

The view resolves defaults from locale where supported and permits explicit configuration for deterministic hosts/tests.

Month-like views display week numbers from this shared primitive. Multi-Month receives them automatically through the shared month-panel renderer.

### 5. Month rendering is shared before Multi-Month is added

The current Month renderer is first decomposed into a reusable month-panel/grid primitive.

The ordinary Month view and the future Multi-Month view must share:

- weekday headings;
- day-cell semantics;
- outside-day handling;
- event rows/overflow;
- background-day shading;
- navigation-bound behaviour;
- internal drag/drop;
- external drop;
- double-click creation;
- accessibility labelling;
- week-number rendering.

Multi-Month must not become a second implementation of Month.

### 6. Generic Timeline is horizontal Calendar time, not Resource Scheduler

A shared core horizontal range-geometry primitive will be extracted from the existing Resource Scheduler timeline basis.

It must support:

- absolute clipping;
- timezone/civil coordinates;
- DST gap/overlap behaviour;
- point events;
- interval width;
- deterministic overlap lanes.

Resource Scheduler should consume the shared primitive after extraction, retaining only resource-row and assignment-specific mechanics.

The generic Timeline view then lays ordinary Calendar occurrences onto horizontal lanes without introducing resources, assignments or Resource Scheduler types into base Calendar.

Timeline interaction should use the existing Calendar authority, snapping, placement and mutation logic. Pointer lifecycle should be shared with the current gesture machinery where doing so removes genuine duplication; dimension-specific geometry remains in small vertical/horizontal adapters.

### 7. Printing is a rendered snapshot, not persistence

Printing will have two layers:

- dedicated `@media print` styling for ordinary in-page Calendar printing;
- a public print-snapshot API that creates a detached, read-only representation of the current rendered view.

The print snapshot should:

- omit toolbar controls, resize handles, context/inline action controls and transient drag/pending state unless explicitly requested;
- expand scroll/clipping containers so the current view prints as content rather than as a viewport;
- preserve occurrence text, time labels, source/event presentation and passive backgrounds where meaningful;
- avoid executing commands or mutating Calendar state;
- support all built-in views plus registered Multi-Month/Timeline views through the same active renderer.

A convenience browser-print method may be added only if it can be implemented without leaking global page state or leaving temporary DOM behind. The detached snapshot is the primary contract.

## Pass programme

### VC-A — Custom-view registry and runtime boundary

**Status:** complete on `working`.

**Objective:** replace hard-coded view orchestration with a view-definition boundary while preserving existing behaviour exactly.

Work:

- introduce UI-level view identity and custom-view plugin contracts;
- validate registered IDs and reserved built-in IDs;
- create an internal descriptor for every existing built-in view;
- route visible-range calculation, navigation shift, title, background-query policy and rendering through the active descriptor;
- add a bounded custom-view action port;
- keep current keyboard shortcuts and toolbar behaviour for existing views;
- let registered custom views appear in the view switcher in deterministic registration order;
- ensure destroying Calendar releases custom-view lifecycle state if any is introduced.

Acceptance:

- Month/Week/Day/Year/Agenda render and navigate identically to baseline;
- no new custom-view code enters `core/`;
- invalid/duplicate plugin IDs fail before rendering;
- custom renderer receives immutable/query-result data, not repository/storage access;
- custom mutation requests route through Calendar authority/placement lifecycle.

Targeted QA:

- range/title/navigation tests for all five built-ins;
- custom registration/duplicate/reserved-ID tests;
- callback range/view identity tests;
- browser smoke switching built-in ↔ test custom view;
- architecture guards for dependency direction.

### VC-B — External drag/drop creation boundary

**Status:** complete on `working`.

**Objective:** allow arbitrary DOM elements to create Calendar events by dropping onto valid Calendar targets.

Work:

- define a bounded external-drag template/payload;
- add Calendar MIME encode/decode helpers for the standard path;
- support an optional host decoder for custom DataTransfer formats;
- centralize external drop target → `CalendarSelection` resolution;
- wire Month day cells, Day/Week all-day lanes and timed columns;
- expose the same target handling through the custom-view action port for future/bundled views;
- use existing create/itemFactory/source/placement/collision/command paths;
- add drag-over acceptance state without interfering with internal occurrence drag/drop.

Acceptance:

- malformed/unknown drag payloads are ignored;
- a valid external drop never bypasses `allowCreate`, source `allowCreate`, navigation bounds, placement guards or collision policy;
- timed drops snap through the configured creation snap policy;
- all-day drops preserve day semantics;
- cancellation/rejection leaves no item or transient state;
- internal occurrence drag/drop remains unchanged.

Targeted QA:

- payload round-trip and invalid-data tests;
- source/placement/collision rejection tests;
- browser drag from an unrelated DOM element into Month, all-day and timed targets;
- internal-vs-external drag regression tests.

### VC-C — Week-number primitive and shared month panel

**Status:** complete on `working`.

**Objective:** add correct week numbers and prepare Month mechanics for Multi-Month without duplication.

Work:

- add pure week-year/week-number calculation to core time utilities;
- support configurable minimum-days-in-first-week;
- resolve locale defaults in the view with deterministic fallback;
- add `weekNumbers` view configuration;
- extract reusable Month panel/grid rendering;
- render week-number gutter/labels in ordinary Month;
- preserve seven-day event geometry and accessibility.

Acceptance:

- correct rollover at late-December/early-January boundaries;
- correct behaviour for Monday/Sunday/custom week starts;
- timezone changes do not alter the civil week identity of the same displayed date;
- Month without week numbers remains visually/semantically unchanged;
- Month renderer has one day-cell/event implementation.

Targeted QA:

- pure week-number boundary cases;
- Month DOM/accessibility tests with week numbers on/off;
- narrow-screen rendering;
- visual snapshot with week numbers enabled.

### VC-D — Multi-Month bundled view

**Objective:** provide a detailed multi-month calendar without duplicating Month logic.

Provisional factory:

```text
createMultiMonthView({
  months: 3,
  columns: "auto",
  stepMonths: 3
})
```

Exact naming is finalized during the pass after type/ergonomic review.

Work:

- implement as a registered view plugin;
- calculate one contiguous projection range covering every displayed month panel;
- render 2–12 detailed month panels using the shared Month renderer;
- support responsive automatic column count plus an explicit column option;
- use configurable navigation step, defaulting to the displayed month count;
- inherit week-number, background, event-overflow, creation and drop behaviour from Month;
- preserve navigation bounds at partial-range edges.

Acceptance:

- no duplicate Month day-cell/event/drop logic;
- months remain chronologically ordered across year boundaries;
- events overlapping panel boundaries appear only where appropriate;
- range query is performed once for the whole visible multi-month surface;
- responsive layout remains usable on narrow screens.

Targeted QA:

- 2/3/6/12-month range tests;
- year-boundary navigation;
- background and recurring occurrence coverage;
- browser interaction/drop tests;
- desktop/narrow visual snapshots.

### VC-E — Generic Timeline bundled view

**Objective:** add a resource-free horizontal temporal view using shared Calendar geometry.

Provisional factory:

```text
createTimelineView({
  spanDays: 7,
  tick: "auto"
})
```

Work:

- extract a generic horizontal range-coordinate helper from Resource Scheduler timeline geometry into core;
- move Resource Scheduler onto the shared helper and verify no behavioural drift;
- add ordinary occurrence horizontal layout with overlap lanes and point markers;
- add timeline axis/ticks and passive background ranges;
- support configurable visible span and navigation step;
- implement open, create, move and resize through Calendar's action/mutation port;
- extend/extract gesture lifecycle only where necessary so pointer arming, touch long-press, cancellation and horizontal auto-scroll are not duplicated;
- support external drops onto timeline coordinates;
- retain keyboard occurrence operations and accessibility labels.

Acceptance:

- no Resource Scheduler/resource types in generic Timeline;
- Resource Scheduler tests remain unchanged in behaviour;
- DST civil geometry agrees with existing day/week/resource timeline semantics;
- point events remain zero-duration but visually targetable;
- overlap lanes are deterministic;
- drag/resize/drop use configured snapping and placement guards;
- stale/host-command semantics are unchanged.

Targeted QA:

- generic timeline geometry and DST tests;
- overlap/point tests;
- Resource Scheduler regression suite;
- pointer/touch/keyboard interaction browser tests;
- external drop browser test;
- visual snapshots.

### VC-F — Print stylesheet and print-snapshot API

**Objective:** provide reliable, read-only printing for the active Calendar view.

Work:

- add dedicated print media rules;
- add a detached print-snapshot API for the active view;
- remove transient controls/state from the print representation;
- expand scroll containers and avoid viewport clipping;
- support Month/Week/Day/Year/Agenda plus Multi-Month/Timeline;
- preserve semantic text, event/background presentation and useful headings;
- define a bounded print options object;
- add a convenience `print()` wrapper only if cleanup and multi-calendar isolation are demonstrably reliable.

Acceptance:

- printing does not mutate Calendar state or trigger commands;
- no resize handles/context controls/drag ghosts/pending previews appear;
- hidden scroll content needed for the active print view is printable;
- multiple Calendar instances do not interfere with one another;
- print output remains legible in light/dark host pages.

Targeted QA:

- DOM print-snapshot structural tests;
- Playwright `emulateMedia({ media: "print" })` checks;
- print visual snapshots for at least Month, Week, Multi-Month and Timeline.

### VC-G — Independent audit, consolidation and programme closure

**Objective:** prove the five capabilities form one coherent extension rather than accumulated patches.

Audit:

- dependency direction;
- duplicate Month/timeline/gesture/drop logic;
- dead branches/helpers;
- package exports/tree-shaking boundaries;
- callback and view-ID correctness;
- external-drop authority safety;
- navigation bounds across every view;
- DST/timezone/point-event correctness;
- accessibility semantics;
- print isolation;
- custom plugin lifecycle/error containment.

QA:

1. targeted unit suites for each capability;
2. complete Node suite;
3. native browser interaction suite across Chromium/Firefox/WebKit as configured;
4. visual regression suite including new view/print baselines;
5. package dry-run and declaration build;
6. independent source audit after all implementation is complete.

Closure documentation:

- fold stable architectural contracts into `docs/ARCHITECTURE.md`;
- update README public capability/subpath documentation;
- remove this programme document once implementation history is safely represented by version control and the enduring architecture documentation.

## Cross-pass acceptance matrix

Every pass that introduces a rendering surface must verify:

- source visibility/filtering;
- occurrence presentation extensions;
- occurrence capability overlays;
- navigation bounds;
- point events;
- recurring occurrences;
- timezone/DST behaviour where applicable;
- host-expanded occurrence projections;
- background ranges where the view declares them meaningful;
- command pending/error lifecycle for interactive operations;
- narrow/mobile behaviour;
- no host-domain concepts in generic source.

## Explicit non-goals

This programme does not add:

- resources to generic Timeline;
- arbitrary host HTML injection into Calendar-owned event cards;
- a second persistence model for views;
- custom-view access to repository/storage internals;
- server-side rendering;
- PDF generation;
- appointment booking/product workflows;
- infinite-scroll or virtualization unless profiling during Timeline/Multi-Month implementation proves it necessary;
- a general plugin framework for non-view concerns.

## Completion standard

The programme is complete only when:

- all five requested capabilities are present;
- Multi-Month and Timeline use the custom-view boundary rather than new hard-coded CalendarUi branches;
- external drag/drop uses the canonical create/placement/mutation path;
- week numbers and Multi-Month share one Month implementation;
- Timeline and Resource Scheduler share generic horizontal temporal geometry where appropriate;
- print output is a read-only rendering concern;
- targeted and comprehensive QA are green;
- a final de novo audit finds no concrete correctness, duplication or architectural-boundary defect.

No further abstraction should be introduced merely to reduce line count or imitate another calendar library.
