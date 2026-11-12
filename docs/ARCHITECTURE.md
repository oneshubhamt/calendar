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
features/resource-scheduler ── optional headless resource hierarchy/assignment/placement dimension
features/resource-availability ── optional resource-scoped availability adapter
features/resource-time-grid ── optional headless vertical resource TimeGrid geometry
features/resource-scheduler-ui ── optional DOM horizontal resource timeline; read-only unless interaction is configured
features/resource-time-grid-ui ── optional DOM vertical resources-as-columns TimeGrid

integration/* + adapters/* ── optional host-specific modules
```

Generic layers never import Director integrations/adapters/fixtures. `view/` also does not import `features/personal`, `features/personal-ui`, `features/planning`, `features/availability`, `features/resource-scheduler`, `features/resource-availability`, `features/resource-time-grid`, `features/resource-scheduler-ui` or `features/resource-time-grid-ui`. The package root exports only **core + view**. IndexedDB storage, interoperability, every specialized feature and host integration require explicit subpath imports. There is deliberately no aggregate `@director/calendar/features` entry point: consumers opt into feature modules individually. Optionality has two deliberate levels: lightweight base-view capabilities such as week-number support, external-drop support and print-snapshot support ship with `view/` but remain behaviorally dormant until explicitly selected, while heavier/specialized capabilities such as Multi-Month, Timeline and all resource features require explicit package subpath imports.

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

`view/` supplies month, week, day and year rendering plus day/week/month/rolling-30-day agenda lists, optional Month week-number gutters, month-overflow expansion, event details/editor, dual-edge timed resizing, cross-day drag/drop, external DOM-to-Calendar creation, range selection, touch long-press, auto-scroll, keyboard editing/navigation, jump-to-date, accessibility announcements/dialogs and narrow-screen behavior. Agenda grouping is overlap-aware so carry-in and multi-day events remain visible inside shorter list ranges. Calendar-owned toolbar/date-navigation/view-switch/source/create chrome can be suppressed independently for embedded hosts. Optional inclusive local-date navigation bounds clamp anchors, bound host projection/collision queries and fail closed on create/move/resize placement outside the permitted dates while leaving surrounding view geometry non-interactive. View orchestration is descriptor-driven inside the DOM layer: the five built-ins and explicitly registered custom views provide range calculation, navigation shift, title, background-query policy and rendering through one validated registry. Custom view IDs may not collide with built-ins or one another. Custom renderers receive Calendar-owned, deeply frozen copies of projected sources/occurrences/backgrounds plus a bounded action port for open/create/move/resize/navigation and optional external drop, resolved snap/DST/pointer interaction policy, and a bounded render port for Calendar-owned reusable view primitives; they receive no repository, storage or interoperability object, and all mutation actions continue through Calendar's existing authority, placement and command lifecycle. A per-render `dispose(element)` hook is invoked before refresh replacement, view switching and Calendar destruction so optional views can release gesture/listener state without leaking lifecycle machinery into Calendar core. The render port currently exposes only the canonical detailed Month panel and rejects a requested panel whose complete Month grid lies outside the active custom view's already-queried range. External drop is a creation boundary only and is dormant by default. A host explicitly opts in with `externalDrop: true` for Calendar's bounded standard MIME payload, or by supplying an explicitly declared host decoder (which itself opts the capability in). Calendar owns/validates the payload synchronously at drop, resolves the view target to a `CalendarSelection`, then passes the resulting draft through `itemFactory`, source-create authority, navigation bounds, placement guards, collision policy and the normal create command. Internal occurrence drag uses its separate private MIME type and is never reinterpreted as external creation.

Week identity is a core civil-time primitive rather than a renderer convention. `weekOfYear()` is parameterized by the displayed `weekStartsOn` value and the minimum days required in week 1, and returns both week-year and week number across December/January rollover without depending on DOM or locale APIs. The view's optional `weekNumbers` setting resolves only the minimum-days policy from `Intl.Locale` week information when available, with a deterministic four-day fallback; hosts/tests can supply `minimumDaysInFirstWeek` explicitly. The existing displayed week-start default remains unchanged unless the host supplies `weekStartsOn`. Detailed Month rendering is centralized in `month-panel.ts`: ordinary Month delegates to that panel, which owns weekday headings, day cells, outside-day state, event overflow, passive backgrounds, bounds, internal/external drop, double-click creation, accessibility labels and week-number rendering. The panel takes its own month range rather than reading the overall view range. The optional `@director/calendar/view/multi-month` module uses the custom-view registry plus that bounded Month render port to compose 2–12 detailed panels over one contiguous query range; it contains no day-cell/event/drop mechanics of its own. Its default identity is `multi-month`, navigation defaults to the displayed month count, explicit `stepMonths` can narrow that step, and `columns: "auto" | 1..6` is a responsive preferred column target rather than a second layout engine. Cross-year titles/navigation remain month-based, while navigation bounds and source visibility continue to be enforced by Calendar. The compact built-in Year view remains separate. Custom-view render context also receives Calendar's already-resolved week-number policy, so Multi-Month reuses the exact numbering policy rather than reinterpreting locale rules.

Horizontal temporal geometry is likewise centralized rather than view-specific. `core/horizontal-timeline.ts` owns absolute range validation/clipping, elapsed or civil/DST x-coordinate mapping, inverse coordinate resolution, point/interval width, deterministic visual overlap lanes and bounded axis ticks. With a timezone it uses the same civil timeline basis as Day/Week: spring-forward gaps remain non-targetable and fall-back overlaps require explicit earlier/later disambiguation. Resource Scheduler now contributes only resource hierarchy/assignment expansion and passes resource-row lane groups into this generic pipeline; its DOM renderer also consumes the same generic axis ticks. The optional `@director/calendar/view/timeline` module is a registered custom view with no resource types or assignments. It renders one horizontal occurrence surface over a configurable 1–90 civil-day span, requests passive backgrounds with the same query, preserves zero-duration point identity, and routes open/create/move/resize/external-drop/keyboard operations through the custom-view action port. `view/pointer-gesture.ts` owns axis-neutral pointer arming, touch long-press, pointer capture, cancellation, click suppression and frame-based two-axis edge auto-scroll; ordinary Day/Week drag, Resource Scheduler and Timeline retain only their small geometry-specific movement/preview adapters.

Refresh orchestration is single-flight. While one projection query is in flight, further invalidations or explicit refresh requests mark one trailing refresh rather than launching parallel queries; callers awaiting `refresh()` wait through that trailing authoritative pass. Superseded query results are not rendered. If a superseded in-flight query fails after a newer refresh has already been queued, Calendar drains the newer request instead of stranding it behind the obsolete failure; only a final unsuperseded refresh failure rejects.

The view has no built-in planned/actual, deadline, milestone, Study/Revision/Practice, category or history semantics. It never interprets arbitrary `metadata` keys; optional features/adapters own such meaning.

Hosts can configure:

- `kindOptions`;
- reminder channel choices (with unknown existing channels preserved);
- default ownership/edit policy;
- `itemFactory` for host-controlled creation;
- optional external DOM drag creation through Calendar's standard MIME helper or one synchronous host decoder whose MIME types are declared up front; external drops require a normal create command path and never use `handleCreate` as an alternate persistence path;
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

Resource Scheduler is an optional, DOM-free sibling capability for hosts that schedule a second dimension such as rooms, people or equipment. Resources are not Calendar sources and are never inferred from event metadata. The feature owns a flat `parentId` hierarchy contract, range-bounded resource projection, range-bounded batch assignment projection, independent reassignment authority, feature-local resource placement guards and an atomic resource/time mutation port. Its contracts live in a dedicated type leaf; mechanics, placement and timeline modules depend on that leaf rather than importing their own public barrel.

Hierarchy and assignment mechanics are fail-closed and deterministic. Validation rejects duplicate, missing, self-referential or cyclic ancestry; siblings sort by explicit integer order and then resource ID; collapse IDs must exist and remain caller-owned UI state; assignments must reference known occurrences and explicitly assignable resources; multi-resource associations preserve the complete assignment set rather than inventing a single-resource shortcut. `layoutResourceTimeline()` is the dedicated horizontal geometry layer: it clips to the requested range, reuses Calendar civil/DST mapping when a zone is supplied, keeps point occurrences at zero temporal width, emits one render identity per occurrence/resource association, and uses resource-local visual lanes without changing scheduling semantics.

The separate `features/resource-availability` subpath is headless and optional. `CalendarResourceAvailabilityDefinition` targets one or more assignable resources while delegating recurrence, exception and DST expansion to `features/availability`; it never adds resource identity to generic Calendar availability or event storage. Visual resource availability is passive. Enforcement is explicit through `createResourceAvailabilityPlacementGuard()`, which composes into the existing resource guard chain, checks every target resource against one authoritative snapshot per decision, and preserves generic `exclude-unavailable` / `require-available` semantics.

The separate `features/resource-time-grid` subpath exposes `layoutResourceTimeGrid()`, the vertical resources-as-columns geometry counterpart. Its requested range must start and end at local-day boundaries in the configured timezone; DST-short and DST-long local days are valid, while partial boundary days fail closed instead of rendering content outside the requested range. It derives local day × assignable-resource columns in canonical hierarchy order, reuses `layoutTimedDay()` for event/DST/point/overlap geometry and `layoutBackgroundDay()` for resource-availability shading, keeps all-day associations separate, and does not duplicate civil-time or overlap-lane algorithms.

The base remains resource-free: `CalendarItem`, `CalendarOccurrence` and `CalendarView` gain no resource fields or resource timeline member; ordinary `CalendarUi` and `layoutTimedDay()` do not understand resource rows; Calendar persistence stores no resource tree or assignments by default. Hosts remain authoritative for resource and assignment state. A host that does not import these resource subpaths receives no resource hierarchy, availability, TimeGrid or resource-UI runtime work. `features/resource-scheduler` deliberately does not re-export resource availability or vertical TimeGrid mechanics, so opting into basic resource scheduling does not implicitly traverse those modules.

Resource placement is intentionally separate from temporal placement. Later mutation passes compose the existing `evaluateCalendarPlacement()` pipeline with resource target validation, resource-specific guards/collision policy and resource reassignment authority, then submit one `CalendarResourcePlacementChange` through `CalendarResourceMutationPort.commit()`. A combined time/resource drag must never become two independent writes. The headless `executeCalendarResourcePlacement()` path re-evaluates generic temporal placement plus independent resource policy/authority and then performs exactly one host `CalendarResourceMutationPort.commit()` carrying the complete before/after resource assignment, proposed time, scope and assignment version. Host version checks are atomic with the write; stale rejection is not retried.

The optional DOM horizontal timeline is a separate `features/resource-scheduler-ui` subpath. By default it is a data-driven read-only surface over already-projected resources, occurrences, assignments and a range. Deterministic treegrid/timeline composition lives in a renderer module that consumes a projection model plus only occurrence-render and collapse callbacks; the stateful UI coordinator retains host callbacks plus horizontal targeting/preview/focus state, while the shared orientation-neutral resource interaction lifecycle owns pending state, execution-result handling, authoritative reprojection and failure semantics. This keeps pointer/keyboard geometry close to the surface without duplicating mutation policy between horizontal and vertical resource UIs. The Scheduler UI reuses the headless resource-timeline geometry and structured occurrence-presentation resolver, renders empty resource rows and nested headers, and does not fetch providers, expand recurrence, persist data or mutate host state. Provider orchestration is intentionally host-owned: hosts invoke the resource and assignment providers, own subscription/invalidation and authoritative occurrence coordination, then pass a complete range snapshot to the Scheduler UI. This avoids creating a second Calendar engine or hidden resource state. When explicit interaction options are supplied, writes still pass only through the atomic headless executor. Scheduler interaction uses the same core `CalendarSnapPolicy`, minute-snap primitive, explicit-offset parser, civil-time/DST machinery and interval-resize primitive as ordinary Calendar. It is not a `CalendarUiAddon` and does not add a `CalendarView` member.

The vertical DOM counterpart is the separate `features/resource-time-grid-ui` subpath, built on the independently opt-in `features/resource-time-grid` geometry and optional `features/resource-availability` projections. It is likewise projection-driven and read-only by default. It renders resources as columns with a bounded all-day strip, timed event lanes and passive per-resource availability backgrounds. Timed pointer/touch/keyboard moves and resizes are enabled only with explicit interaction options. Horizontal Resource Scheduler and vertical Resource TimeGrid share `executeCalendarResourceInteraction()` for recurrence scope, warning confirmation and the single atomic resource/time commit, then share one orientation-neutral UI lifecycle for pending ownership, result callbacks, authoritative reprojection and failure semantics. Each UI keeps only orientation-specific targeting, preview, focus and scrolling logic.

### Placement policy

`CalendarPlacementGuard` is the generic optional scheduling-policy boundary. A guard receives the proposed absolute start/end, all-day flag, action label, primary time zone, target `calendarId` when known and the original occurrence for edits/moves/resizes. It returns `allow`, `warn` or `prevent` plus an optional bounded reason. Multiple guards are evaluated in declaration order; `prevent` dominates, warnings are aggregated into one confirmation, malformed/throwing/duplicate guards fail closed, and absence of guards preserves existing behavior.

`evaluateCalendarPlacement()` is the shared headless temporal-placement pipeline in core. It composes navigation bounds, placement guards and collision policy in one deterministic `allow / warn / prevent` result. Collision occurrences are supplied lazily by the consuming surface, so core does not depend on `CalendarEngine` or any UI implementation; if collision policy requires evaluation but the occurrence source is unavailable or fails, the result fails closed. `CalendarUi.allowPlacement()` is now only a view adapter: it builds the generic placement context, supplies an event-only collision query, delegates to `evaluateCalendarPlacement()`, and owns the DOM confirmation/announcement behavior. Built-in create/duplicate/edit, drag/drop, pointer resize, keyboard move/resize and add-on `createDraft`/`canPlaceDraft`/`patchOccurrence` paths all use that adapter. A future optional scheduling surface can call the same core evaluator without copying Calendar UI logic. Custom host `handleCreate`/`handleEdit` callbacks receive the same `CalendarPlacementValidationPort` so a host-owned editor can validate its final draft; because Calendar never sees a final draft that the host mutates entirely outside Calendar, the host remains responsible for invoking that port before committing.

`createAvailabilityPlacementGuard()` is an explicit opt-in adapter in `features/availability`. `exclude-unavailable` reacts only to overlapping unavailable definitions; `require-available` additionally requires the complete placement interval (or point instant) to be covered by available definitions, with unavailable time taking precedence. The guard may warn or prevent as explicitly configured. Source-associated definitions apply only to their target Calendar source; global definitions apply to all. Merely projecting or rendering availability backgrounds never installs this guard.

## Persistence

`CalendarSnapshotProvider` is the minimal read/query boundary; the engine does not require mutation methods. `CalendarProjectionProvider` may expose host-owned `CalendarItem` values which Calendar recurrence-expands, while `CalendarOccurrenceProjectionProvider` supplies already-expanded `CalendarOccurrence` values for the exact requested range. Projection results are immutable host snapshots for the lifetime of a query/result: hosts replace changed values and signal invalidation rather than mutating previously returned entities, and Calendar deliberately avoids deep-cloning potentially large host schedules. Either event projection boundary may expose an invalidation subscription so host-owned data can refresh the UI without duplicating persistence. Item projections are integrity-checked before recurrence expansion; occurrence projections are validated separately for source, source-item, occurrence-identity and chronology integrity and are never recurrence-expanded again. Independent item, occurrence and (when requested) background projection groups are started concurrently; their validation and composition still occur in the canonical item → occurrence → background order.

Passive temporal context has a separate `CalendarBackgroundProjectionProvider`. It supplies already-expanded `CalendarBackgroundRange` values for a requested range; Calendar canonicalizes absolute boundaries, validates strict chronology, stable identity, optional source association and bounded metadata, filters to the query range/source visibility, and exposes them separately as `CalendarQueryResult.backgroundRanges`. Background ranges are not `CalendarItem`s or `CalendarOccurrence`s and therefore do not enter event recurrence, search, agenda, counts, reminders, actions, collision layout or mutation authority. Event-only engine queries can set `includeBackgroundRanges: false`, in which case passive providers are not invoked; collision validation uses this path, and Year/Agenda refreshes also omit background projection because those views do not render it. Background-provider invalidations participate in the same engine subscription path. `layoutBackgroundDay()` maps those resolved ranges into civil wall-clock geometry using the same DST basis as timed events, clips first to the local day and then to an optional visible-minute window, and returns deterministic back-to-front paint order without creating event columns or collision semantics. Day/week views render timed background ranges inside a dedicated z-index-0 stacking layer with `pointer-events: none`; selection remains z-index 1, timed events begin at z-index 2, and the current-time marker remains above them. Explicit `allDay: true` ranges are grouped by the local days their absolute interval overlaps and shade Month cells plus Day/Week all-day lanes through a separate pointer-transparent day-level layer. Timed ranges are never promoted into day-level shading and out-of-navigation-bounds surfaces do not render background layers. Year deliberately omits backgrounds because its compact cells cannot truthfully represent timed intervals without defining a separate aggregation/summary semantic; Agenda deliberately omits them because it is an ordered event/occurrence list and turning passive context into rows would falsely make it event-like. Day-level labels enrich the containing surface's accessible description rather than becoming event-like rows. `CalendarBackgroundDisplay` exposes only cosmetic color/text/class tokens, host class names pass through the existing safe-token gate, and extension CSS remains subject to the existing geometry-blocking sanitizer. Background labels are inserted only through text DOM APIs. `CalendarRepository` adds mutable item operations, while source-management capabilities remain explicit. Memory and IndexedDB repositories share canonical patch/integrity behavior. Persisted state fails closed on malformed sources/items, invalid chronology/temporal/recurrence/reminder definitions, duplicate identities, and non-JSON-like/oversized/cyclic metadata.

Repository snapshots are runtime-immutable ownership boundaries: external values are cloned once on ingress, deeply frozen, and thereafter changed by copy-on-write while unchanged entities are structurally shared. `read()` therefore returns the same frozen snapshot until a successful mutation instead of cloning on every read. Item create/update/remove and source create/update/remove use one internal set of pure state transitions shared by memory persistence, IndexedDB persistence and command staging; those layers differ only in commit/materialization strategy rather than reimplementing mutation semantics. Semantic equality over Calendar's validated JSON-like values likewise uses one canonical comparator: object key insertion order and optional undefined properties do not create false differences, while array order remains significant. The same canonical representation backs command-history source signatures and interoperability fingerprints. `RepositoryCommandHandler` stages each logical item command in an immutable copy-on-write snapshot—owning changed/new caller values before execution yields—and publishes exactly one authoritative `replaceAtRevision()`; recurrence splits and other multi-item commands cannot expose or durably commit a half-applied intermediate state. Undo/redo history is derived from the validated staged command result and retains only affected immutable item versions plus compact ordering anchors, not a post-commit reread or complete item snapshots. Undo/redo validates the affected identities and source state, reconstructs from the current authoritative item set, preserves unrelated later item changes, and commits the resulting delta through the same revision-guarded atomic replacement boundary. `CalendarRepository` requires atomic `replaceAtRevision()`; command execution, undo and redo never fall back to an unguarded check-then-write path. Hosts that do not own mutable Calendar state use `CalendarSnapshotProvider` instead. IndexedDB compares the expected revision with the persisted revision inside the same read/write transaction as the write, so concurrent tabs cannot silently overwrite each other. A stale writer aborts and reloads authoritative state. `BroadcastChannel`, when available, is used only to accelerate cross-tab invalidation; correctness depends on transactional compare-and-swap rather than message delivery. Concurrent invalidation messages are coalesced by revision and any newer invalidation arriving during an in-flight reload is drained before the refresh completes. The coordinator does not self-requeue an advertised revision that storage never contains, avoiding an unbounded reload loop on malformed/stale channel traffic. Repository revision and engine invalidation are deliberately distinct: `CalendarSnapshot.revision` / `CalendarQueryResult.repositoryRevision` identify durable repository state for optimistic concurrency, while `CalendarEngine.generation()` / `CalendarQueryResult.generation` advance for any repository or projection invalidation. CalendarEngine owns one upstream subscription set and fans each invalidation out to all consumers, avoiding duplicate provider subscriptions. Repository/engine observer failures are isolated after authoritative state publication: one failing listener cannot make a committed mutation appear rejected or prevent sibling listeners from receiving the same notification.

IndexedDB keeps the public in-memory topology snapshot-oriented while persisting one metadata/revision record plus independent source/item records in one fixed Calendar object store. Every commit performs revision CAS and writes/deletes only changed entities plus compact order/revision metadata in one transaction. Runtime snapshots remain immutable and structurally shared regardless of durable representation. Repository opening is single-flight: concurrent callers share one physical IndexedDB open/read, while `close()` invalidates any in-flight generation so an older asynchronous completion cannot resurrect a closed repository or overwrite a later reopen. Cross-context reload and revision-check work is generation-scoped as well: an advisory reload started before `close()` cannot mutate reopened state or clear/coalesce against the newer generation's reload slot. Cross-context convergence deliberately reloads the authoritative normalized snapshot after a newer revision is observed instead of maintaining a second incremental cache protocol. Item/source order metadata and full reload are therefore O(N) in repository size; that is an explicit simplicity/correctness trade-off for the intended personal-calendar scale. A delta journal, secondary indexes or changed-ID refresh protocol should be introduced only after measured workloads demonstrate that this O(N) boundary is material.

Browser persistence has one canonical physical state: `director-calendar`, IndexedDB version 1. The production browser-storage API exposes no database-name override: repository, sync-state and reminder-receipt persistence therefore cannot create parallel application roots. Its exact schema contains three object stores: `calendar` uses `keyPath: "key"`; `syncStates` and `reminderReceipts` use out-of-line keys. All three disable auto-increment and indexes. The Calendar repository and interoperability stores share one internal IndexedDB substrate for schema creation, exact topology validation and strict-durability read/write transactions, so either layer may open the database first without creating a parallel root. At the current version, any other version or topology fails closed and there is no alternate durable generation or background conversion path. If a future release genuinely changes the durable schema, the change must occur through one explicit ordered IndexedDB upgrade at the canonical open boundary, with previous-version browser fixtures proving preservation and rollback/failure behavior; it must never create a parallel database root or an ad-hoc conversion path. Obsolete upgrade code should be removed once its supported upgrade window has intentionally closed.

IndexedDB is optional. A host such as a native/Rust application may project a read-only snapshot into the engine and route commands through its own adapter instead of duplicating authoritative data in browser storage.

## Interoperability

RFC 5545 iCalendar import/export preserves supported recurrence/date/time semantics, UID/RECURRENCE-ID identity and `VALARM` reminders. Import ownership/kind/edit policy are host-configurable rather than Calendar-owned defaults.

Google Calendar is an adapter with overlay/import/publish/opt-in two-way modes. Google IDs, iCalUIDs, etags, sequences and sync tokens remain distinct from local IDs. Interoperability identity is namespaced under `metadata.calendarInterop`, preserving host metadata. Imported ownership/kind/edit policy and publish predicates are host-configurable. HTTP 412 becomes a structured conflict rather than silent last-write-wins. One sync for a connection is held under an origin-scoped browser Web Lock for its complete read/pull/remote-mutation/local-commit/state-write lifecycle, preventing concurrent tabs from issuing duplicate remote mutations; non-browser runtimes use an in-process exclusive fallback. Pull-side local creates, updates and deletes are staged against one repository snapshot and published through at most one revision-guarded `replaceAtRevision()` commit per sync, so a multi-event pull cannot durably expose a half-applied local batch. The connection checkpoint is written only after that local commit. Because Google and IndexedDB cannot share a distributed transaction, retry convergence is explicit: if the current local and remote semantic fingerprints already agree after a failed checkpoint, the link is rebased instead of reported as a false both-modified conflict; semantically unchanged incremental events still refresh provider identity such as etag/sequence, and links disappear once both sides are already deleted.

Each connection intentionally persists one validated checkpoint record containing its token, timestamps and `links[]`. This keeps token advancement and the complete conflict baseline coherent in one IndexedDB write. Ordinary links retain compact fingerprints/identity only; a full `baseRemoteItem` is retained only for recurring masters that need prior series state to fold detached-instance deltas during incremental pulls. A separate indexed sync-link store would reduce write amplification only at much larger link counts while adding schema and transactional machinery, so normalization is deferred until measured connection sizes justify it. Persisted sync state and reminder receipts are validated on every read/mutation and fail closed on malformed records.

Browser reminders are opportunistic foreground delivery with receipt deduplication/retry. Delivery uses an atomic short-lived receipt claim before invoking a channel, then completes or releases that exact claim; the default IndexedDB store therefore prevents two tabs from concurrently delivering the same reminder while allowing an abandoned claim to expire and retry. Reminder channel identifiers are host-extensible; built-ins use `in-app`, `browser` and `external`. Reliable closed-app delivery is delegated to OS-backed calendar paths such as ICS/Google rather than overstating browser alarm guarantees.

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

`CalendarCommandLifecycle` is the canonical mutation-completion boundary for Calendar-owned create/update/remove commands, occurrence commands, source actions and history operations. Occurrence-scoped commands remain pending until execution and the attempted authoritative refresh finish, record the pending operation (`move`, edge resize, edit or action) while suppressing concurrent commands for the same occurrence, preserve pending state across host invalidations/re-renders, and surface failures through the view's accessible status channel. Before an occurrence command executes, Calendar resolves the latest occurrence with the same stable occurrence identity and rebuilds both the outgoing command and command context around that authoritative payload; stale rendered presentation/projection metadata is never forwarded after execution-time revalidation. Tentative drag/resize geometry remains independent of DOM nodes and is reconstructed across intermediate re-renders. All mutation lifecycle outcomes distinguish `rejected` from `committed-refresh-failed`; once a command, undo or redo has committed, a reprojection failure is never represented as a command rejection that callers might safely retry. `CalendarCommandStaleError` gives trusted hosts a generic explicit stale/revision rejection signal; Calendar never performs fallback persistence for trusted-host commands.

### Embedded UI ownership and host theme

`CalendarUi` is a composite DOM widget, not an application shell. The element passed to its constructor is a dedicated mount boundary. While the instance is alive Calendar owns the children it mounts there, calendar-local view/navigation state, calendar interaction geometry, focus behavior inside the widget, dialogs/menus and Calendar accessibility semantics. A host must not concurrently render unrelated application DOM into that same mount. The containing application remains authoritative for its surrounding shell and routing, domain records and business rules, persistence/backup/recovery, global presentation and cross-application navigation.

Calendar deliberately does not use Shadow DOM. Its base stylesheet is namespace-contained under `.dc-*` selectors so native dialogs, accessibility/focus behavior, custom views and host composition remain straightforward. Calendar-created dialogs are appended beneath the supplied mount, context/source/add-on menus remain beneath the Calendar root, add-on and custom-view DOM is mounted only into Calendar-provided containers, and `createPrintSnapshot()` returns a detached inert clone rather than moving or borrowing live host DOM.

Embedded hosts have a small supported presentation bridge through `CalendarUiOptions.theme` / `CalendarUiTheme`: `background`, `softBackground`, `text`, `mutedText`, `border`, `accent`, `danger` and `fontFamily`. Values are validated CSS values and may reference host variables with `var(...)`. Internally these map to the namespaced inherited properties `--dc-theme-background`, `--dc-theme-soft-background`, `--dc-theme-text`, `--dc-theme-muted-text`, `--dc-theme-border`, `--dc-theme-accent`, `--dc-theme-danger` and `--dc-theme-font-family`; hosts may alternatively set those properties on the dedicated mount through CSS. Calendar temporarily overrides only those namespaced inline properties when the typed `theme` option is supplied and restores any pre-existing inline values on destruction. Omitted tokens retain the existing standalone defaults.

The theme bridge is intentionally presentation-only. Hosts cannot use it to redefine grid dimensions, event placement, overflow, drag/resize hit areas, responsive breakpoints or other Calendar-owned geometry. Richer occurrence decoration continues through the existing safe presentation-extension/add-on boundaries.

### Embedded mode and navigation bounds

Calendar can be used as a complete calendar application or as a sub-surface inside another product. Embedded mode may suppress Calendar-owned chrome such as the toolbar, view switcher, date navigation and source controls while retaining the selected calendar geometry and interactions.

Hosts may also provide navigation bounds. Calendar treats these as generic temporal limits, not as journey/study/project semantics.

### Multi-zone display

The primary calendar zone continues to govern geometry, visible-range calculation, grouping, projection queries, drag/drop, resizing and command context. `CalendarUiOptions.secondaryTimeZone` may optionally add one validated IANA reference scale to day/week views only. It is presentation, not a second temporal model.

Non-time-grid view composition is isolated in a renderer module: Year, Month and Agenda own their DOM/layout assembly there, together with shared rendering primitives and passive day-background composition. `CalendarUi` supplies only generic state plus callbacks for authority, commands, host presentation and navigation. The time grid remains in `CalendarUi` because its event geometry is tightly coupled to live move/resize/selection semantics; extracting it would create a broad callback façade without reducing conceptual coupling.

Pointer/touch drag lifecycle is isolated in a DOM-only gesture controller: it owns arming thresholds, long-press activation, pointer listeners, visual previews, auto-scroll, cancellation and post-drag click suppression. `CalendarUi` remains the semantic coordinator and interprets a completed drag through placement authority, civil-time resolution and command dispatch; the controller cannot mutate Calendar state.

Calendar UI semantic time comes from the existing `CalendarClock` abstraction. Initial anchoring, Today navigation, extension context, creation/update timestamps and command context all use that clock; pointer click-suppression remains an interaction timer. A lightweight temporal-chrome controller updates today classes and the current-time marker on aligned minute ticks against already-rendered DOM, so midnight/current-time maintenance does not re-query host projections or rebuild authoritative state.

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

Explicit package subpaths allow hosts to import only the layers they need. Base-view capabilities introduced by the view programme are behaviorally dormant unless selected: `weekNumbers` defaults off, custom views require explicit registration, external drop requires explicit opt-in/decoder, and live-page print media requires `print: true`; the detached print snapshot is created only by an explicit method call. The root is the ordinary generic product surface (`core + view`), while `@director/calendar/core` remains available for headless use. Specialized capabilities have individual subpaths and there is no aggregate features barrel. `demo/generic.html` proves bare core + view with non-Director travel/notes data and no optional personal/planning/storage/interoperability dependency; `demo/index.html` separately demonstrates explicit personal + planning + Director opt-ins. Clean builds remove `dist/` first so deleted modules cannot survive in release archives.

Current package: `@director/calendar` **1.2.0**. The actual TypeScript declarations and explicit package exports are the sole package contracts. This codebase intentionally contains no migration, legacy-compatibility or contract-bridging layer: only the current application/package contract is supported. The published package contains production `dist/`, canonical docs and README only; repository demos, fixtures, tests and TypeScript sources are not part of the npm surface.

## Engineering contract

Material changes follow:

**audit → objectives → implementation → verify objectives → targeted QA**

Run broad QA after substantial cumulative changes and before release/integration milestones. Source inspection tests are reserved for dependency direction, package boundaries, forbidden migration/compatibility paths and similarly structural invariants; user-visible behavior belongs in unit/integration/browser tests. Browser release QA builds the production modules first and exercises native IndexedDB/cross-tab behavior, rendering/interaction smoke coverage and visual baselines across the configured Playwright projects. The release workflow runs inside the version-pinned official Playwright Noble container, with Node/npm/TypeScript/Playwright versions verified explicitly, so screenshot baselines are not coupled to rolling GitHub-hosted runner packages. Keep this document current-state only; implementation history belongs in version control.


### Resource Scheduler interaction boundary

`features/resource-scheduler-ui` and `features/resource-time-grid-ui` enable mutation only when an explicit interaction configuration supplies the resource mutation port and authority/policy inputs. Pointer, touch and keyboard gestures produce tentative UI-only geometry, then route one complete candidate through `executeCalendarResourceInteraction()`, which resolves recurrence scope/warnings before submitting a single `CalendarResourcePlacementRequest` to `executeCalendarResourcePlacement()`. The UI never writes resource and time separately and never mutates its projected host snapshot optimistically. Resource projections are immutable host snapshots: each UI owns and freezes its collection/range containers but deliberately retains supplied entity identities rather than deep-cloning potentially large schedules, so hosts publish changes by replacing the projection rather than mutating previously supplied entities. A multi-resource drag replaces only the rendered resource association; all other associations survive. Hosts remain responsible for authoritative reprojection after commit or stale-version rejection.
