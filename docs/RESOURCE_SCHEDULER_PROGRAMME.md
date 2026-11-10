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

## R4 — Read-only Resource Timeline UI

Add the separate optional `features/resource-scheduler-ui` subpath with nested headers, expand/collapse, time axis, resource rows, event rendering, scrolling and keyboard/accessibility foundations. Do not add a Calendar view enum member or use `CalendarUiAddon`.

After R4, audit the read-only architecture independently before writes.

## R5 — Placement policy, authority and atomic mutation

Compose `evaluateCalendarPlacement()` with resource target validity, resource-specific guards/collision policy and independent resource reassignment authority. Execute exactly one `CalendarResourceMutationPort.commit()`, with full before/after assignments and stale-version handling.

## R6 — Full interaction surface

Add horizontal time drag, vertical resource reassignment, diagonal combined drag, resize, pointer/touch, keyboard equivalents and interaction preview. Dragging one rendering of a multi-resource occurrence replaces only that resource assignment.

## R7 — Independent closure audit and QA

Verify hierarchy integrity, collapse/order, multi-resource behavior, unassigned events, resource-scoped policy, recurrence scopes, DST/cross-midnight/point occurrences, temporal/resource authority, trusted host projections, stale versions, atomic failure behavior, accessibility and negative dependency/persistence leakage. Then run the complete repository quality gate.

## Current architecture after R2

The headless contract lives only under `src/features/resource-scheduler/` and is exported only from `@director/calendar/features/resource-scheduler`. It imports core types only. Base root/core/view remain unchanged and resource-free. R2 adds only pure headless validation/projection mechanics. No Resource Scheduler runtime module is loaded unless its explicit subpath is imported.
