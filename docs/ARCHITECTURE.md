# Director Calendar — Architecture Contract

## Purpose

Director Calendar is generic calendar software. It owns calendar mechanics; host applications own domain meaning.

The kernel understands time, recurrence, occurrences, commands, layout, interaction, persistence and interoperability. It does **not** understand journeys, notes, studying, revision, mocks, payments, habits or any other host domain. Those concepts enter through data, optional features and adapters.

## Dependency rule

```text
core ───────────────┬─ view
                    ├─ storage
                    └─ interoperability

features/personal ── pure optional service
features/personal-ui ── optional DOM add-on built on that service
features/planning ── optional presentation/semantics extension
features/availability ── optional temporal context + placement-policy adapter
features/resource-scheduler ── optional headless resource scheduling dimension
features/resource-scheduler-ui ── optional read-only DOM resource timeline built on resource-scheduler

integration/* + adapters/* ── optional host-specific modules
```

Generic layers never import Director integrations/adapters/fixtures. `view/` also does not import `features/personal`, `features/personal-ui`, `features/planning`, `features/availability`, `features/resource-scheduler` or `features/resource-scheduler-ui`. The package root exports only **core + view**. IndexedDB storage, interoperability, every specialized feature and host integration require explicit subpath imports. There is deliberately no aggregate `@director/calendar/features` entry point: consumers opt into `features/personal`, `features/personal-ui`, `features/planning`, `features/availability` or future feature modules individually.

## Core contracts

### Items

`CalendarItem.kind` and `ownership` are opaque non-empty host-extensible identifiers. `metadata` is a bounded JSON-like envelope; the kernel assigns no domain meaning to arbitrary keys.

Mutation authority is explicit:

- `full` — semantic and temporal editing;
- `schedule-only` — only temporal/scheduling changes;
- `readonly` — immutable through calendar commands;
- `generated` — immutable generated projection.

The command boundary also enforces source capabilities. `readOnly` sources cannot be mutated, `allowCreate: false` blocks creation/movement into the source, and `removable: false` protects source removal. UI restrictions are convenience, not the security/invariant boundary. Undo/redo also compares the current item/source state with its recorded history entry and fails closed rather than overwriting independent host/sync changes.

### Sources

`sourceType` is opaque host metadata, not a closed calendar enum. Sources may carry generic metadata and display information. Repositories do not infer mutability/removability from source names or types. Source grouping/category conventions, when desired, live in optional feature metadata rather than the core source schema.

### Time

Calendar values explicitly distinguish:

- `instant` — absolute timestamp;
- `zoned` — wall time in an IANA timezone;
- `floating` — wall time without a fixed timezone;
- `date` — all-day/date-only value.

The built-in editor preserves those representations. Whole-series edits made from any occurrence project the edit back to the original series anchor rather than replacing the anchor with the selected occurrence date. Civil operations use explicit calendar/item zones; non-midnight logical days are available as the generic `dayBoundaryStart` primitive for adapters that need them.

### Recurrence

The supported RFC 5545-style model includes interval/count/until, weekday and ordinal weekday rules, month-day/month rules, `BYSETPOS`, exceptions, cancellation/replacement, and this/following/all series edits. The recurrence engine itself operates on generic `CalendarTemporalSeries` values and resolves temporal identity, ordinal, DST/timezone behavior, edit projection and exception rebasing without importing `CalendarItem` or `CalendarOccurrence`. `event-series.ts` is a narrow mapping adapter that turns resolved temporal ranges into event occurrences; availability calls the temporal recurrence engine directly. Invalid civil dates are skipped rather than silently clamped. The built-in editor exposes common repeat patterns directly and the remaining engine filters through a generic advanced recurrence disclosure; malformed combinations fail before publication.

## Generic view

`view/` supplies month, week, day and year rendering plus day/week/month/rolling-30-day agenda lists, month-overflow expansion, event details/editor, dual-edge timed resizing, cross-day drag/drop, range selection, touch long-press, auto-scroll, keyboard editing/navigation, jump-to-date, accessibility announcements/dialogs and narrow-screen behavior. Agenda grouping is overlap-aware so carry-in and multi-day events remain visible inside shorter list ranges. Calendar-owned toolbar/date-navigation/view-switch/source/create chrome can be suppressed independently for embedded hosts. Optional inclusive local-date navigation bounds clamp anchors, bound host projection/collision queries and fail closed on create/move/resize placement outside the permitted dates while leaving surrounding view geometry non-interactive.

The view has no built-in planned/actual, deadline, milestone, Study/Revision/Practice, category or history semantics. It never interprets arbitrary `metadata` keys; optional features/adapters own such meaning.

Hosts can configure:

- `kindOptions`;
- reminder channel choices (with unknown existing channels preserved);
- default ownership/edit policy;
- `itemFactory` for host-controlled creation;
- handled `handleCreate`, `handleOpen`, `handleEdit` callbacks to replace built-in UI;
- source action ports;
- UI extensions;
- item/source icon, color, text color and safe CSS class names;
- independently visible Calendar chrome through `chrome`;
- optional inclusive `navigationBounds` for embedded/bounded calendar surfaces.

## Optional features

### `features/personal` + `features/personal-ui`

`features/personal` is a DOM-free opt-in service providing text/source/type/category filtering, search across nested metadata, quick-create grammar, calendar-source construction, copy/move-to-date and reusable routines. `features/personal-ui` is a separate optional DOM add-on that contributes search/filter/quick-create/routine/source-management controls to the generic view. Neither is required by `view/`. They reserve no semantic kind such as `history`, `deadline`, `planned` or `actual`.

Routine templates default to generic events and may opt into host ownership/edit policy/metadata. They do not inherently mean “planned”.

### `features/planning`

Provides optional planning semantics and presentation: deadlines/milestones, planned-vs-actual pairing, variance/day summaries and planning-specific CSS. Its defaults are conventions local to that feature and can be replaced through `PlanningSemantics` predicates/extractors.

A consumer that does not import this feature receives none of those semantics or CSS.

### `features/availability`

Provides optional DOM-free availability semantics. `CalendarAvailabilityDefinition` expresses `available` or `unavailable` time, optional source association, label/display/metadata and a temporal recurrence/exception contract over the same `RecurrenceRule` model used by events. `expandAvailabilityDefinitions()` calls the generic temporal recurrence engine directly and maps resolved temporal ranges into passive `CalendarBackgroundRange` values with stable identities and namespaced `metadata.calendarAvailability`. Availability does not construct synthetic `CalendarItem` values or pass through event validation.

`createAvailabilityBackgroundProvider()` reads authoritative definitions on every projection request and may forward an invalidation subscription; it stores no availability state in Calendar persistence. The feature defines semantic background context only. It does not alter collisions, mutation authority or placement acceptance; any such enforcement remains a separate optional policy layer.

### `features/resource-scheduler`

Resource Scheduler is an optional, DOM-free sibling capability for hosts that schedule a second dimension such as rooms, people or equipment. Resources are not Calendar sources and are never inferred from event metadata. The feature owns a flat `parentId` hierarchy contract, range-bounded resource projection, range-bounded batch assignment projection, independent reassignment authority, feature-local resource placement guards and an atomic resource/time mutation port.

The base remains resource-free: `CalendarItem`, `CalendarOccurrence` and `CalendarView` gain no resource fields or resource timeline member; ordinary `CalendarUi` and `layoutTimedDay()` do not understand resource rows; Calendar persistence stores no resource tree or assignments by default. Hosts remain authoritative for resource and assignment state. A host that does not import this subpath receives no Resource Scheduler module or runtime work.

Resource placement is intentionally separate from temporal placement. Later mutation passes compose the existing `evaluateCalendarPlacement()` pipeline with resource target validation, resource-specific guards/collision policy and resource reassignment authority, then submit one `CalendarResourcePlacementChange` through `CalendarResourceMutationPort.commit()`. A combined time/resource drag must never become two independent writes. R5's headless `executeCalendarResourcePlacement()` re-evaluates generic temporal placement plus independent resource policy/authority and then performs exactly one host `CalendarResourceMutationPort.commit()` carrying the complete before/after resource assignment, proposed time, scope and assignment version. Host version checks are atomic with the write; stale rejection is not retried.

The optional DOM timeline is a separate `features/resource-scheduler-ui` subpath. By default it remains a data-driven read-only surface over already-projected resources, occurrences, assignments and a range. It owns collapse/scroll/focus presentation state only, reuses the headless R3 geometry and structured occurrence-presentation resolver, renders empty resource rows and nested headers, and does not fetch providers, expand recurrence, persist data or mutate host state. It is not a `CalendarUiAddon` and does not add a `CalendarView` member.

### Placement policy

`CalendarPlacementGuard` is the generic optional scheduling-policy boundary. A guard receives the proposed absolute start/end, all-day flag, action label, primary time zone, target `calendarId` when known and the original occurrence for edits/moves/resizes. It returns `allow`, `warn` or `prevent` plus an optional bounded reason. Multiple guards are evaluated in declaration order; `prevent` dominates, warnings are aggregated into one confirmation, malformed/throwing/duplicate guards fail closed, and absence of guards preserves existing behavior.

`evaluateCalendarPlacement()` is the shared headless temporal-placement pipeline in core. It composes navigation bounds, placement guards and collision policy in one deterministic `allow / warn / prevent` result. Collision occurrences are supplied lazily by the consuming surface, so core does not depend on `CalendarEngine` or any UI implementation; if collision policy requires evaluation but the occurrence source is unavailable or fails, the result fails closed. `CalendarUi.allowPlacement()` is now only a view adapter: it builds the generic placement context, supplies an event-only collision query, delegates to `evaluateCalendarPlacement()`, and owns the DOM confirmation/announcement behavior. Built-in create/duplicate/edit, drag/drop, pointer resize, keyboard move/resize and add-on `createDraft`/`canPlaceDraft`/`patchOccurrence` paths all use that adapter. A future optional scheduling surface can call the same core evaluator without copying Calendar UI logic. Custom host `handleCreate`/`handleEdit` callbacks receive the same `CalendarPlacementValidationPort` so a host-owned editor can validate its final draft; because Calendar never sees a final draft that the host mutates entirely outside Calendar, the host remains responsible for invoking that port before committing.

`createAvailabilityPlacementGuard()` is an explicit opt-in adapter in `features/availability`. `exclude-unavailable` reacts only to overlapping unavailable definitions; `require-available` additionally requires the complete placement interval (or point instant) to be covered by available definitions, with unavailable time taking precedence. The guard may warn or prevent as explicitly configured. Source-associated definitions apply only to their target Calendar source; global definitions apply to all. Merely projecting or rendering availability backgrounds never installs this guard.

## Persistence

`CalendarSnapshotProvider` is the minimal read/query boundary; the engine does not require mutation methods. `CalendarProjectionProvider` may expose host-owned `CalendarItem` values which Calendar recurrence-expands, while `CalendarOccurrenceProjectionProvider` supplies already-expanded `CalendarOccurrence` values for the exact requested range. Either event projection boundary may expose an invalidation subscription so host-owned data can refresh the UI without duplicating persistence. Item projections are integrity-checked before recurrence expansion; occurrence projections are validated separately for source, source-item, occurrence-identity and chronology integrity and are never recurrence-expanded again.

Passive temporal context has a separate `CalendarBackgroundProjectionProvider`. It supplies already-expanded `CalendarBackgroundRange` values for a requested range; Calendar canonicalizes absolute boundaries, validates strict chronology, stable identity, optional source association and bounded metadata, filters to the query range/source visibility, and exposes them separately as `CalendarQueryResult.backgroundRanges`. Background ranges are not `CalendarItem`s or `CalendarOccurrence`s and therefore do not enter event recurrence, search, agenda, counts, reminders, actions, collision layout or mutation authority. Event-only engine queries can set `includeBackgroundRanges: false`, in which case passive providers are not invoked; collision validation uses this path, and Year/Agenda refreshes also omit background projection because those views do not render it. Background-provider invalidations participate in the same engine subscription path. `layoutBackgroundDay()` maps those resolved ranges into civil wall-clock geometry using the same DST basis as timed events, clips first to the local day and then to an optional visible-minute window, and returns deterministic back-to-front paint order without creating event columns or collision semantics. Day/week views render timed background ranges inside a dedicated z-index-0 stacking layer with `pointer-events: none`; selection remains z-index 1, timed events begin at z-index 2, and the current-time marker remains above them. Explicit `allDay: true` ranges are grouped by the local days their absolute interval overlaps and shade Month cells plus Day/Week all-day lanes through a separate pointer-transparent day-level layer. Timed ranges are never promoted into day-level shading and out-of-navigation-bounds surfaces do not render background layers. Year deliberately omits backgrounds because its compact cells cannot truthfully represent timed intervals without defining a separate aggregation/summary semantic; Agenda deliberately omits them because it is an ordered event/occurrence list and turning passive context into rows would falsely make it event-like. Day-level labels enrich the containing surface's accessible description rather than becoming event-like rows. `CalendarBackgroundDisplay` exposes only cosmetic color/text/class tokens, host class names pass through the existing safe-token gate, and extension CSS remains subject to the existing geometry-blocking sanitizer. Background labels are inserted only through text DOM APIs. `CalendarRepository` adds mutable item operations, while source-management capabilities remain explicit. Memory and IndexedDB repositories share canonical patch/integrity behavior. Persisted state fails closed on malformed sources/items, invalid chronology/temporal/recurrence/reminder definitions, duplicate identities, and non-JSON-like/oversized/cyclic metadata.

IndexedDB is optional. A host such as a native/Rust application may project a read-only snapshot into the engine and route commands through its own adapter instead of duplicating authoritative data in browser storage.

## Interoperability

RFC 5545 iCalendar import/export preserves supported recurrence/date/time semantics, UID/RECURRENCE-ID identity and `VALARM` reminders. Import ownership/kind/edit policy are host-configurable rather than Calendar-owned defaults.

Google Calendar is an adapter with overlay/import/publish/opt-in two-way modes. Google IDs, iCalUIDs, etags, sequences and sync tokens remain distinct from local IDs. Interoperability identity is namespaced under `metadata.calendarInterop`, preserving host metadata. Imported ownership/kind/edit policy and publish predicates are host-configurable. HTTP 412 becomes a structured conflict rather than silent last-write-wins.

Browser reminders are opportunistic foreground delivery with receipt deduplication/retry. Reminder channel identifiers are host-extensible; built-ins use `in-app`, `browser` and `external`. Reliable closed-app delivery is delegated to OS-backed calendar paths such as ICS/Google rather than overstating browser alarm guarantees.

## Advanced host-owned temporal integration

Some hosts already possess a richer scheduling domain than Calendar should ever duplicate. In that mode Calendar is an embedded temporal surface over host-owned records rather than the authoritative scheduler.

The generic architecture therefore distinguishes two projection levels:

- **item projection** — the host supplies `CalendarItem` values and Calendar expands supported recurrence itself;
- **occurrence projection** — the host supplies already-expanded occurrences for a requested range when recurrence, completion, exceptions, quotas or other temporal semantics are authoritative outside Calendar.

An occurrence projection must preserve stable source-item identity and stable host occurrence identity. Calendar may lay out, render, move, resize, select and navigate those occurrences, but it must not reinterpret their recurrence or manufacture host-domain state.

The implemented generic contract is:

```ts
interface CalendarOccurrenceProjectionProvider {
  readonly id: string;
  projectOccurrences(range: CalendarRange): Promise<readonly CalendarOccurrence[]> | readonly CalendarOccurrence[];
  subscribe?(listener: () => void): () => void;
}
```

`CalendarEngine` accepts these providers independently of existing item projections: `new CalendarEngine(repository, itemProjections?, occurrenceProjections?)`. Projected occurrences use their globally stable `occurrenceId` for Calendar interaction identity, `sourceItemId` for the authoritative source-record identity, and optional `projectionIdentity` for any additional provider-owned recurrence/occurrence key. They do not carry a redundant item `id`. Host-expanded `start`, `end` and `originalStart` must be absolute ISO date-times; Calendar canonicalizes offsets before integrity/range processing and fails closed on date-only or floating occurrence boundaries. `projectionIdentity` is bounded JSON-like data: Calendar validates and carries it unchanged but never interprets its structure. One-off Calendar-owned occurrences use `item:<sourceItemId>` identity, so moving them does not change interaction identity; recurring identities remain anchored to their recurrence identity.

### Per-occurrence authority

The coarse item-level `EditPolicy` remains the fail-closed default, while `CalendarOccurrenceCapabilityProvider` can narrow authority per occurrence:

```ts
interface CalendarOccurrenceCapabilities {
  commandPath?: "default" | "trusted-host";
  canMove?: boolean;
  canMoveBetweenAllDayAndTimed?: boolean;
  canResizeStart?: boolean;
  canResizeEnd?: boolean;
  canOpen?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  canChangeRecurrence?: boolean;
  canInvokeActions?: boolean;
}

interface CalendarOccurrenceCapabilityProvider {
  capabilities(occurrence: CalendarOccurrence): CalendarOccurrenceCapabilities | undefined;
}
```

With the default command path, provider values can only narrow the authority already granted by `editPolicy` and source `readOnly`. A `trusted-host` result is the sole generic widening mechanism: each widened operation must be explicitly `true`, and Calendar routes its command to the separately supplied trusted host command handler rather than its repository command path. Missing or malformed capability values fail closed.

The view independently applies move, all-day/timed conversion, start resize, end resize, open, edit, delete/cancel, recurrence-change and inline-action authority. Drag handles, keyboard shortcuts and context/detail actions use the resolved capabilities, and command execution resolves them again immediately before calling the handler. Editor saves and add-on patches use the same temporal-mutation classifier: equal endpoint deltas require move authority, independent endpoint changes require the corresponding resize authority, and all-day/timed transitions additionally require conversion authority. Schedule-only base records retain schedule editing without semantic-field authority; `canEdit` is exclusively semantic edit authority while move/resize/conversion use their dedicated capabilities. An explicit `trusted-host` + `canEdit` result may widen semantic editing, and the editor consumes that resolved decision rather than independently overriding it from `EditPolicy`. Calendar never infers permissions from semantic kinds.

### Temporal presentation semantics

Not every temporal object is a duration-bearing appointment. `CalendarItem.temporalForm` is a generic geometry contract: omitted/`interval` values retain ordinary start/end interval behavior, while `point` represents a true zero-duration instant and therefore requires `start === end`. Point values cannot be date-only/all-day.

The view maps those temporal forms into generic presentation/layout semantics:

- interval duration blocks;
- point markers;
- all-day entries;
- multi-day spans.

Point markers are range-tested by their instant, recurse without acquiring duration, participate in month/year/agenda grouping, and receive zero-duration time-grid geometry. Multiple markers at the same instant and markers inside duration blocks are assigned collision columns for visual legibility, while scheduling collision policy does not treat a point as occupying minutes. Point markers can edit, duplicate or move their single instant while preserving `start === end`; the editor does not expose an authoritative end field, point duplication preserves `temporalForm: "point"`, and resize/all-day conversion remain mechanically unavailable. Calendar retains layout, interaction and accessibility ownership without assigning any host meaning such as deadline or payment.

### Host presentation and inline actions

Embedded applications may supply structured occurrence presentation without taking over layout. `CalendarOccurrencePresentation` supports a safe text `icon`, `leading`, `title`, `subtitle`, `trailing`, `badges`, detail rows, agenda metadata and an optional complete occurrence-level `accessibleLabel`. Slot content is text-only (`string` or `CalendarPresentationText`); Calendar renders it through DOM text APIs and never accepts arbitrary host HTML or DOM ownership. The structured icon overrides `CalendarDisplay.icon` for that occurrence presentation. Multiple badges compose, while later extensions may override earlier singular slots. Dataset decoration accepts only safe camelCase identifier keys with string values; malformed/reserved runtime keys are ignored before reaching `HTMLElement.dataset`.

The existing `CalendarSourceActionPort` remains the single host action boundary. `CalendarSourceAction` keeps its stable opaque `id` and `label` and may expose a safe text `icon`, `inline`, `accessibleLabel`, `state`, `pressed`, `enabled`, `pending`, `primary`, `danger` and open-ended `kind` presentation metadata. Existing providers remain menu/detail-only unless they explicitly opt an action into `inline: true`. Duplicate or malformed action identities fail closed.

Calendar owns the occurrence card structure: geometry is non-interactive, a dedicated primary button owns open/keyboard behavior, and independent native action buttons own inline commands. Inline pointer/click/keyboard handling is isolated from event open/drag/resize. Action execution is revalidated against the current provider state and `canInvokeActions`, then uses the same occurrence-scoped pending/duplicate-suppression/refresh/error lifecycle as other host commands. Semantic meaning and persistence remain entirely host-owned.

Presentation hooks are isolated from Calendar failure: a failing `presentOccurrence` contribution is ignored while later extensions still render. `CalendarUiExtension.styles` is a cosmetic-only CSS boundary scoped beneath `.dc-root`; geometry declarations, malformed scope-breaking selectors and `!important` fail closed. Presentation data is emitted only in the `data-host-*` namespace and host class names cannot reuse Calendar `dc-*`/`is-*` namespaces. Add-on CSS is scoped to the add-on wrapper, accepts only flat rules plus one conservative `@media` level, and rejects `!important`. Calendar-owned geometry is not a host CSS API.

### Command routing and optimistic safety

For host-owned occurrences, drag/drop, resizing, keyboard scheduling and other Calendar commands may route through the explicit `trustedHostCommandHandler`. `CalendarCommandContext` carries stable generic identity: `occurrenceId`, `sourceItemId`, optional opaque `projectionIdentity`, and requested `seriesScope`, in addition to the occurrence itself.

`CalendarCommandLifecycle` keeps occurrence-scoped commands pending until execution and the attempted authoritative refresh finish, records the pending operation (`move`, edge resize, edit or action) while suppressing concurrent commands for the same occurrence, preserves pending state across host invalidations/re-renders, and surfaces failures through the view's accessible status channel. Tentative drag/resize geometry is stored independently of DOM nodes and is reconstructed across intermediate re-renders. Lifecycle outcomes distinguish `rejected` from `committed-refresh-failed`; once the host mutation has committed, a reprojection failure is never represented as a command rejection that callers might safely retry. `CalendarCommandStaleError` gives trusted hosts a generic explicit stale/revision rejection signal; Calendar never performs fallback persistence for trusted-host commands.

### Embedded mode and navigation bounds

Calendar can be used as a complete calendar application or as a sub-surface inside another product. Embedded mode may suppress Calendar-owned chrome such as the toolbar, view switcher, date navigation and source controls while retaining the selected calendar geometry and interactions.

Hosts may also provide navigation bounds. Calendar treats these as generic temporal limits, not as journey/study/project semantics.

### Multi-zone display

The primary calendar zone continues to govern geometry, visible-range calculation, grouping, projection queries, drag/drop, resizing and command context. `CalendarUiOptions.secondaryTimeZone` may optionally add one validated IANA reference scale to day/week views only. It is presentation, not a second temporal model.

A shared civil-timeline model is used by primary layout and wall-clock interaction. An event at 03:00 therefore remains aligned with the 03:00 grid line on a spring-forward day; nonexistent wall times are explicitly non-targetable instead of silently resolving forward, and repeated fall-back wall times use `CalendarUiOptions.dstOverlapDisambiguation` (`earlier` by default, or `later`). The event editor uses the same resolution rule. Secondary hour labels resolve those primary civil hours against actual IANA rules: half-hour offsets are preserved, gaps are explicit, overlaps expose both reference values, civil-date rollover is shown as `-1d`/`+1d`, and week labels retain distinct converted values when offsets differ across visible days. The additional axis remains additive chrome; occurrence identity, projection and command semantics continue to use only the primary zone.

These capabilities are intentionally generic. They enable hosts with authoritative temporal domains without adding journeys, tasks, payments, habits, study sessions or any other application concept to Calendar core.

## Host integrations

Current optional adapters demonstrate the boundary:

- Study Director maps its schedule gateway, logical study day and immutable history behind its adapter.
- Revision Director maps generated due markers and separate scheduled sessions without changing scheduler authority.
- Practice Desk maps attempts and scheduler-derived due dates without moving FSRS into calendar core.

These modules are not architectural dependencies of generic calendar code. Other hosts should implement their own thin translation/command boundaries rather than add domain concepts to core/view.

Ayana is the first planned consumer of the advanced host-owned temporal integration described above. Its specific mapping, UX target and non-goals are documented in `AYANA_INTEGRATION.md`; the staged delivery programme is in `AYANA_IMPLEMENTATION_PROGRAMME.md`. Those documents may name Ayana concepts, but they do not extend the generic core vocabulary.

Scheduling interactions preserve one canonical temporal representation: all-day placement is date-only and timed placement is an instant unless a host/editor explicitly preserves zoned or floating semantics. Series splitting treats recurrence cardinality and exception lineage as one operation: unchanged rules retain only the remaining occurrence count, pre-split exceptions stay with the head, and surviving tail exceptions are remapped to the new series. View grouping is bounded to the requested range so long-span occurrences do not create work outside the visible surface.

## Distribution and demos

Explicit package subpaths allow hosts to import only the layers they need. The root is the ordinary generic product surface (`core + view`), while `@director/calendar/core` remains available for headless use. Specialized capabilities have individual subpaths and there is no aggregate features barrel. `demo/generic.html` proves bare core + view with non-Director travel/notes data and no optional personal/planning/storage/interoperability dependency; `demo/index.html` separately demonstrates explicit personal + planning + Director opt-ins. Clean builds remove `dist/` first so deleted modules cannot survive in release archives.

Current package: `@director/calendar` **1.1.0**. Generic core contract: **11**. Interoperability contract: **2**. The published package contains production `dist/`, canonical docs and README only; repository demos, fixtures, tests and TypeScript sources are not part of the npm surface.

## Engineering contract

Material changes follow:

**audit → objectives → implementation → verify objectives → targeted QA**

Run broad QA after substantial cumulative changes and before release/integration milestones. Keep this document current-state only; implementation history belongs in version control.


### Resource Scheduler interaction boundary

`features/resource-scheduler-ui` enables mutation only when an explicit interaction configuration supplies the R5 mutation port and authority/policy inputs. Pointer, touch and keyboard gestures produce tentative UI-only geometry, then submit one complete `CalendarResourcePlacementRequest` to `executeCalendarResourcePlacement()`. The UI never writes resource and time separately and never mutates its projected host snapshot optimistically. A multi-resource drag replaces only the rendered resource association; all other associations survive. Hosts remain responsible for authoritative reprojection after commit or stale-version rejection.
