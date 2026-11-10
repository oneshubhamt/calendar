# Resource Scheduler Programme

## Purpose

Resource Scheduler is a purely optional sibling capability for scheduling Calendar occurrences against a separate resource dimension such as rooms, people or equipment. It must remain generic, host-authoritative and removable by simply not importing its package subpath.

## Package and dependency contract

```text
@director/calendar
    core + ordinary generic Calendar view

@director/calendar/core
    headless generic Calendar

@director/calendar/features/resource-scheduler
    optional headless resource contracts/mechanics

@director/calendar/features/resource-scheduler-ui
    planned optional DOM resource timeline
```

Dependency direction is one-way:

```text
core
 ↑
 ├── ordinary view
 ├── availability
 └── resource-scheduler
          ↑
    resource-scheduler-ui
```

Core and ordinary view never import Resource Scheduler. There is no aggregate `@director/calendar/features` barrel.

## Invariants

- Resources are a separate scheduling dimension from Calendar sources.
- `CalendarItem` and `CalendarOccurrence` do not gain `resourceId` or `resourceIds`.
- `CalendarView` does not gain `resourceTimeline`.
- Ordinary `CalendarUi` and `layoutTimedDay()` remain resource-unaware.
- Resource trees and assignments are not added to Calendar persistence by default.
- Resource semantics are never inferred from arbitrary event metadata.
- Resource recurrence/timezone logic is not duplicated.
- Resource reassignment authority remains separate from temporal authority.
- A combined resource/time change is one atomic host mutation.
- Resource Scheduler is not implemented as a `CalendarUiAddon`.
- A host that does not import the feature gets zero resource initialization or runtime work.

## R1 — Contracts, package boundary and documentation

R1 establishes contracts only:

- flat `CalendarResource` hierarchy with explicit `acceptsAssignments`;
- cosmetic `CalendarResourceDisplay`;
- range-bounded `CalendarResourceProvider`;
- range-bounded batch `CalendarResourceAssignmentProvider`;
- opaque assignment version identity;
- independent resource capability provider;
- feature-local placement context and guard;
- atomic `CalendarResourcePlacementChange` and mutation port;
- explicit `./features/resource-scheduler` package export;
- negative architecture tests for root/core/view isolation.

R1 intentionally contains no hierarchy validation, assignment integrity mechanics, timeline geometry, DOM UI, persistence or mutation implementation.

## R2 — Resource hierarchy and assignment integrity

Add fail-closed validation for duplicate/missing/self/cyclic hierarchy relationships, deterministic sibling order and flattening, caller-supplied collapsed IDs, explicit assignability, assignment/resource integrity and deterministic multi-resource association. No DOM.

### R2 implementation notes

Pure operations are `validateCalendarResources()`, `flattenCalendarResources(resources, collapsedResourceIds)`, `validateCalendarResourceAssignments(resources, occurrences, assignments)` and `associateCalendarResources(resources, occurrences, assignments)`. Validation rejects malformed IDs/titles, duplicate IDs, invalid order/display/metadata, orphan/self/cyclic ancestry, invalid collapse IDs, unknown/duplicate occurrence or resource assignments, non-assignable targets and malformed opaque versions. Siblings sort by explicit integer order then resource ID; assignments normalize in flattened resource order, and association pairs sort by row then occurrence ID. Unassigned occurrences have no association pairs, with no synthetic assignment record. Collapsed IDs are caller-provided UI state, never stored.

These routines do not fetch host providers, interpret recurrence, mutate assignments, allocate resource UI, implement geometry, or persist state. Providers continue to own their projections. Assignment validation uses the complete hierarchy, independent of UI collapse state.

## R3 — Resource timeline geometry

Add dedicated `layoutResourceTimeline()`. Reuse existing time/civil/DST semantics; do not alter `layoutTimedDay()`. Produce deterministic horizontal time geometry, resource rows, overlap lanes and occurrence-resource render identity.

### R3 implementation notes

`layoutResourceTimeline(resources, occurrences, assignments, range, options)` is a dedicated optional horizontal geometry function. It accepts already-expanded `CalendarOccurrence` values and validated host-owned assignments, clips intervals against the requested absolute range, maps x/width through the existing `civilMinuteOfInstant()` basis when a time zone is supplied, and uses elapsed minutes otherwise. True point occurrences retain zero width.

Each visible assignment produces an occurrence/resource render instance with a collision-safe stable `renderId`, deterministic resource row, x/width and visual lane. Multi-resource occurrences therefore render independently in each assigned row. Lane packing is presentation-only; it does not call placement policy, collision policy, capability providers or mutation ports. Caller-supplied collapsed resource IDs may hide descendant rows without changing the underlying assignment projection.

R3 does not invoke recurrence or create a second time engine. It does not alter `layoutTimedDay()`.

## R4 — Read-only Resource Timeline UI

Add the separate optional `features/resource-scheduler-ui` subpath with nested headers, expand/collapse, time axis, resource rows, event rendering, scrolling and keyboard/accessibility foundations. Do not add a Calendar view enum member or use `CalendarUiAddon`.

### R4 implementation notes

`CalendarResourceSchedulerUi` is a standalone data-driven DOM surface under `features/resource-scheduler-ui`. Hosts call `setProjection()` with already-projected resources, occurrences, assignments and the visible range. The UI validates and builds the replacement DOM before committing it, so malformed projections do not partially replace the current surface.

The treegrid renders one row per visible resource, including empty rows, with sticky nested row headers, explicit expand/collapse controls, a horizontally scrollable time axis, R3 occurrence geometry, UI-only minimum pixel sizes and per-row visual lanes. Collapse state is caller-observable and remains UI state. Structured `CalendarUiExtension.prepare/presentOccurrence` hooks may contribute safe text/icon/badge presentation, but this module never mounts or imports `CalendarUi` and ignores mutation/action semantics.

Keyboard foundations include native Enter/Space activation when a non-mutating host activation callback is supplied, Arrow/Home/End navigation between occurrence cards, ArrowLeft/ArrowRight collapse control semantics, focus-visible styling and scroll-into-view. Touch uses native pan scrolling and manipulation-sized controls; drag/reassignment/resize remain deferred to R6.

The surface does not query providers, expand recurrence, interpret resource policy, invoke authority, persist data or perform mutation.

After R4, audit the read-only architecture independently before writes.

## R5 — Placement policy, authority and atomic mutation

Compose `evaluateCalendarPlacement()` with resource target validity, resource-specific guards/collision policy and independent resource reassignment authority. Execute exactly one `CalendarResourceMutationPort.commit()`, with full before/after assignments and stale-version handling.

### R5 implementation notes

`evaluateCalendarResourcePlacement()` is the single headless policy/authority composition boundary. It validates complete current/target resource sets, canonicalizes them by hierarchy order, reuses core `evaluateCalendarPlacement()` for temporal bounds/guards/collisions, resolves temporal mutation authority through core occurrence capabilities, independently requires explicit `canReassign: true` only when the resource set changes, evaluates feature-local resource guards and optionally evaluates resource-scoped collisions against a lazily supplied occurrence+assignment projection.

Dimension authority is exact: a time-only change requires only its temporal capabilities; a resource-only change requires only resource reassignment authority; a diagonal change requires both. Resource guards never enter core placement context and resource collision candidates are considered only when they share at least one target resource.

`executeCalendarResourcePlacement()` re-evaluates immediately before execution. Prevented placements, unaccepted warnings and no-ops do not write. An accepted mutation calls `CalendarResourceMutationPort.commit()` exactly once with canonical complete before/after assignments, proposed time, recurrence scope and the projected assignment version. Version comparison is host-authoritative and must occur atomically with the write; a `CalendarCommandStaleError` or `code="stale"` rejection produces a stale result and is never automatically retried.

R5 does not add interaction handlers to Resource Scheduler UI; pointer/touch/keyboard mutation interactions remain R6.

## R6 — Full interaction surface

Add horizontal time drag, vertical resource reassignment, diagonal combined drag, resize, pointer/touch, keyboard equivalents and interaction preview. Dragging one rendering of a multi-resource occurrence replaces only that resource assignment.

### R6 implementation notes

Resource Scheduler UI interaction is opt-in through `CalendarResourceSchedulerInteractionOptions`; omitting it preserves the R4 read-only surface. Pointer Events provide one path for mouse, pen and touch. Horizontal movement is converted to snapped civil minutes through the existing civil timeline; vertical movement chooses a visible assignable resource; diagonal movement combines both into one R5 request. Start/end resize handles use the same civil-time shift and core interval-resize primitive. DST gaps fail closed and fall-back overlap resolution is explicit.

Dragging one rendering of a multi-resource occurrence uses `replaceCalendarResourceAssignment()`: only the rendered source resource is replaced, every other assignment is retained, and targeting an already-assigned resource removes the rendered source without creating a duplicate. The resulting complete before/after sets are still canonicalized and revalidated by R5.

The UI renders a non-authoritative drag ghost and target-row preview only; it never mutates its projection optimistically. On drop it resolves recurrence scope (defaulting safely to `this`), calls `executeCalendarResourcePlacement()`, optionally asks a host warning-confirmation callback, and performs no second write. Committed and stale outcomes may request a fresh authoritative projection from the host; otherwise hosts can continue to push data through `setProjection()`.

Keyboard equivalents are explicit: Alt+Left/Right moves by the configured snap interval, Alt+Up/Down reassigns the rendered resource to the adjacent visible assignable resource, and focused start/end resize handles use Left/Right to resize that edge. Enter/Space still activates an occurrence when an activation callback exists. Pending state, live-region announcements, focus restoration, touch pointer capture and edge auto-scroll are UI-only concerns.

R6 does not add Resource Scheduler semantics to ordinary Calendar UI, persistence or core event schemas.

## R7 — Independent closure audit and QA

Verify hierarchy integrity, collapse/order, multi-resource behavior, unassigned events, resource-scoped policy, recurrence scopes, DST/cross-midnight/point occurrences, temporal/resource authority, trusted host projections, stale versions, atomic failure behavior, accessibility and negative dependency/persistence leakage. Then run the complete repository quality gate.

## Current architecture after R6

The headless contract lives only under `src/features/resource-scheduler/` and is exported only from `@director/calendar/features/resource-scheduler`. It imports core types only. Base root/core/view remain unchanged and resource-free. R2 provides pure validation/projection mechanics, R3 adds optional headless timeline geometry, R4 adds a separate opt-in read-only DOM timeline and R5 adds a headless placement/authority/atomic-mutation coordinator. R6 optionally connects the standalone Resource Scheduler UI to the R5 atomic placement executor while preserving a zero-write read-only mode when interaction options are omitted. Core, ordinary view and Calendar persistence remain resource-free; no Resource Scheduler code is loaded unless its explicit subpaths are imported.
