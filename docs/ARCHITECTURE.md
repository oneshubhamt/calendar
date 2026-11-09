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

integration/* + adapters/* ── optional host-specific modules
```

Generic layers never import Director integrations/adapters/fixtures. `view/` also does not import `features/personal`, `features/personal-ui` or `features/planning`. The package root exports only **core + view**. IndexedDB storage, interoperability, personal/planning features and host integrations require explicit subpath imports.

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

The supported RFC 5545-style model includes interval/count/until, weekday and ordinal weekday rules, month-day/month rules, `BYSETPOS`, exceptions, cancellation/replacement, and this/following/all series edits. Invalid civil dates are skipped rather than silently clamped. The built-in editor exposes common repeat patterns directly and the remaining engine filters through a generic advanced recurrence disclosure; malformed combinations fail before publication.

## Generic view

`view/` supplies month, week, day and year rendering plus day/week/month/rolling-30-day agenda lists, month-overflow expansion, event details/editor, dual-edge timed resizing, cross-day drag/drop, range selection, touch long-press, auto-scroll, keyboard editing/navigation, jump-to-date, accessibility announcements/dialogs and narrow-screen behavior. Agenda grouping is overlap-aware so carry-in and multi-day events remain visible inside shorter list ranges.

The view has no built-in planned/actual, deadline, milestone, Study/Revision/Practice, category or history semantics. It never interprets arbitrary `metadata` keys; optional features/adapters own such meaning.

Hosts can configure:

- `kindOptions`;
- reminder channel choices (with unknown existing channels preserved);
- default ownership/edit policy;
- `itemFactory` for host-controlled creation;
- handled `handleCreate`, `handleOpen`, `handleEdit` callbacks to replace built-in UI;
- source action ports;
- UI extensions;
- item/source icon, color, text color and safe CSS class names.

## Optional features

### `features/personal` + `features/personal-ui`

`features/personal` is a DOM-free opt-in service providing text/source/type/category filtering, search across nested metadata, quick-create grammar, calendar-source construction, copy/move-to-date and reusable routines. `features/personal-ui` is a separate optional DOM add-on that contributes search/filter/quick-create/routine/source-management controls to the generic view. Neither is required by `view/`. They reserve no semantic kind such as `history`, `deadline`, `planned` or `actual`.

Routine templates default to generic events and may opt into host ownership/edit policy/metadata. They do not inherently mean “planned”.

### `features/planning`

Provides optional planning semantics and presentation: deadlines/milestones, planned-vs-actual pairing, variance/day summaries and planning-specific CSS. Its defaults are conventions local to that feature and can be replaced through `PlanningSemantics` predicates/extractors.

A consumer that does not import this feature receives none of those semantics or CSS.

## Persistence

`CalendarSnapshotProvider` is the minimal read/query boundary; the engine does not require mutation methods. `CalendarProjectionProvider` may expose an invalidation subscription so host-owned projected data can refresh the UI without duplicating persistence. Combined local + projected data is integrity-checked before recurrence expansion, so duplicate item identities and unknown source references fail closed. `CalendarRepository` adds mutable item operations, while source-management capabilities remain explicit. Memory and IndexedDB repositories share canonical patch/integrity behavior. Persisted state fails closed on malformed sources/items, invalid chronology/temporal/recurrence/reminder definitions, duplicate identities, and non-JSON-like/oversized/cyclic metadata.

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

### Per-occurrence authority

The coarse item-level `EditPolicy` remains useful as a fail-closed default, but embedded hosts may need finer interaction authority for each occurrence. The generic capability contract may independently govern operations such as:

- move;
- resize start;
- resize end;
- edit;
- delete/cancel;
- complete or otherwise invoke a host action;
- change recurrence;
- move between all-day and timed placement.

Calendar must never infer these permissions from semantic kinds such as task, payment or habit. A host capability provider supplies them explicitly, and command execution revalidates them.

### Temporal presentation semantics

Not every temporal object is a duration-bearing appointment. Calendar should support generic presentation/layout semantics for:

- duration blocks;
- point/deadline markers;
- all-day entries;
- multi-day spans;
- optional background/range annotations.

A point/deadline does not acquire an invented duration merely to fit time-grid geometry. Hosts may choose how such values are rendered while Calendar retains responsibility for collision geometry and accessible navigation.

### Host presentation and inline actions

Embedded applications may supply structured occurrence presentation without taking over layout. Generic presentation slots may include a leading affordance/icon, title, subtitle, trailing value and badges, plus detail rows and safe styling metadata.

Hosts may also contribute explicit inline actions. Calendar treats each action as an opaque command identifier with label/state/availability; semantic meaning and persistence remain entirely host-owned.

### Command routing and optimistic safety

For host-owned occurrences, drag/drop, resizing, keyboard scheduling and inline actions route through a host command handler. Command context carries enough stable identity to distinguish:

- source item;
- projected occurrence;
- recurrence/nominal occurrence identity where supplied by the host;
- requested edit scope.

The host remains responsible for translating the command into its domain operation. Calendar must handle pending state, surface errors without silently mutating its projection, and refresh only from the authoritative host result. Concurrent host changes must fail closed rather than be overwritten.

### Embedded mode and navigation bounds

Calendar can be used as a complete calendar application or as a sub-surface inside another product. Embedded mode may suppress Calendar-owned chrome such as the toolbar, view switcher, date navigation and source controls while retaining the selected calendar geometry and interactions.

Hosts may also provide navigation bounds. Calendar treats these as generic temporal limits, not as journey/study/project semantics.

### Multi-zone display

The primary calendar zone continues to govern geometry. An optional secondary time-zone scale may be displayed for travel, distributed work or other host use cases without changing occurrence identity or scheduling semantics.

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

Explicit package subpaths allow hosts to import only the layers they need. `demo/generic.html` proves bare core + view with non-Director travel/notes data and no optional personal/planning/storage/interoperability dependency; `demo/index.html` separately demonstrates explicit personal + planning + Director opt-ins. Clean builds remove `dist/` first so deleted modules cannot survive in release archives.

Current package: `@director/calendar` **1.0.0-rc.9**. Generic core contract: **10**. Interoperability contract: **2**.

## Engineering contract

Material changes follow:

**audit → objectives → implementation → verify objectives → targeted QA**

Run broad QA after substantial cumulative changes and before release/integration milestones. Keep this document current-state only; implementation history belongs in version control.
