# Director Calendar

Release: **1.1.0**.

Director Calendar is reusable, local-first calendar software written in strict TypeScript. The calendar kernel is application-agnostic: hosts supply their own semantic kinds, ownership/provenance, metadata, editors/actions and adapters without changing calendar mechanics.

The package provides month/week/day/year views plus day/week/month/30-day agenda lists, recurrence and exceptions, an advanced recurrence editor, instant/zoned/floating/date-only time, DST-safe movement, drag/drop and dual-edge resize with touch/keyboard interaction, month-overflow expansion, undo/redo, collision/snap policies, search/filtering, multiple calendars, routines, quick-create, IndexedDB persistence, RFC 5545 iCalendar, Google Calendar synchronization, external overlays and reminder delivery contracts. It has no runtime framework or calendar dependency.

## Boundaries

```text
core/                 time, recurrence, occurrences, commands, layout, interaction
view/                 generic month/week/day/year + list UI and generic event/recurrence editor
features/personal     pure search/filter, quick-create, calendars, copy/move, routines
features/personal-ui  OPTIONAL DOM controls for those personal conveniences
features/planning     OPTIONAL deadlines/milestones/planned-vs-actual presentation
storage/              IndexedDB repository
interoperability/     ICS, Google Calendar, sync, overlays, reminders
integration/          OPTIONAL host adapters
```

`kind`, `ownership`, `sourceType` and host metadata are extensible identifiers/data. Generic behavior is governed by explicit capabilities and policies such as `editPolicy`, `readOnly`, `allowCreate`, `removable` and temporal semantics—not by application names or reserved domain kinds.

The root export is deliberately lean: **core + view only**. IndexedDB storage, interoperability, personal conveniences, planning semantics and host integrations are explicit subpaths. The base view does not import either optional feature, so a host can use `core + view` without IndexedDB, Google/ICS, quick-create/search/routines/source-creation code.

## Host customization

A host can:

- define arbitrary kinds such as `journey-plan`, `habit`, `payment`, `note-review` or `study-block`;
- carry nested JSON-like metadata without changing calendar types;
- configure generic type choices; opt into `features/personal-ui` for category/search/filter/quick-create/routines/source management;
- supply an `itemFactory` to control ownership/provenance and new-item shape;
- intercept create/open/edit through handled callbacks and use its own domain UI;
- provide occurrence actions such as open/start/launch/custom, with optional safe text icons, inline rendering, accessible labels, primary/danger emphasis and enabled/pending/pressed/state presentation;
- provide display icon/color/text/class metadata;
- attach optional UI extensions that can supply a safe text icon, leading/title/subtitle/trailing slots, badges, detail rows, a complete occurrence-level accessible-label override and bounded feature-specific data decoration;
- use a read-only snapshot provider when the host owns persistence/commands elsewhere, or a mutable repository when Calendar owns writes; projected host data can publish invalidations without transferring ownership;
- supply `CalendarProjectionProvider` items for Calendar-owned recurrence expansion, or `CalendarOccurrenceProjectionProvider` occurrences when the host has already expanded recurrence for the requested range; host-expanded `start`, `end` and `originalStart` values must be absolute ISO date-times and are canonicalized before range filtering, while any host-local recurrence key belongs in opaque `projectionIdentity`;
- supply `CalendarBackgroundProjectionProvider` values for passive, already-expanded temporal context that remains separate from events and scheduling constraints; `layoutBackgroundDay()` provides civil/DST-safe timed geometry, day/week timed ranges render through a dedicated pointer-transparent background layer, and explicit `allDay: true` ranges shade Month cells plus Day/Week all-day lanes without entering event rows; optional background display color/text/class tokens remain cosmetic-only;
- supply `CalendarOccurrenceCapabilityProvider` for per-occurrence move/conversion/resize/open/edit/delete/recurrence/action authority; default-path results can only narrow existing policy, while explicit `trusted-host` authority routes through `trustedHostCommandHandler` and is revalidated at execution; editor saves and add-on patches derive the same move/resize/conversion requirements from the temporal fields they actually change, and trusted-host semantic editing is not re-blocked by a legacy schedule-only editor branch;
- Calendar applies its built-in occurrence command lifecycle for operation-specific pending state, occurrence-level duplicate suppression, stable occurrence/source/projection identity context, explicit stale-command errors, accessible failures and authoritative refresh after asynchronous host commands; pointer drag/resize previews are stateful and survive re-render until host resolution, and a committed mutation whose reprojection fails is reported distinctly from a rejected mutation so retry cannot duplicate a successful write;
- independently suppress Calendar-owned toolbar/date-navigation/view-switch/source/create chrome through `chrome`, including a fully toolbar-free embedded day grid while keyboard/grid interactions remain active;
- constrain embedded navigation with inclusive local-date `navigationBounds`; initial/programmatic anchors clamp into range, date navigation cannot leave it, host projection queries are clipped, and create/move/resize placement outside the bounds fails closed;
- optionally add a second day/week reference scale with `secondaryTimeZone`; one shared civil-timeline model drives layout and hit-testing, spring-forward gaps are non-targetable, fall-back overlaps use explicit `dstOverlapDisambiguation: "earlier" | "later"`, and half-hour offsets plus `-1d`/`+1d` civil-date rollover remain truthful without changing event identity or command semantics;
- map ICS/Google imports to host-defined ownership/kind/edit policy while interoperability identity stays namespaced under `metadata.calendarInterop`;
- use custom reminder delivery-channel identifiers in addition to the built-in browser/in-app/external conventions.

The base view treats host metadata as opaque and does not infer categories or application semantics from it. Custom reminder channels can be supplied to the editor, and an existing unknown channel is preserved during editing.

The built-in editor preserves temporal meaning: zoned events edit in their own IANA timezone, floating events remain wall-clock values, instant events remain instants, all-day values remain date-only, and point occurrences edit as one instant while preserving `start === end`. Drag/drop and keyboard conversions between all-day and timed placement update start/end, precision and temporal representation atomically rather than leaving mixed state. Recurrence controls cover the common daily/weekly/monthly/yearly patterns and expose the engine's month-day, month, RFC-style weekday/ordinal and set-position filters behind an advanced disclosure. Unchanged recurrence rules are preserved exactly; split-series edits preserve the remaining count and remap only surviving tail exceptions.

True point-in-time values use `temporalForm: "point"` with `start === end`; Calendar does not manufacture a duration for them. They render as exact time-grid markers, participate in month/year/agenda views, and remain zero-duration through editing, duplication and movement; close markers use visual-only horizontal lanes to avoid screen overlap without acquiring scheduling duration, and points cannot be resized or dragged into all-day placement.

## v1.1 host-boundary notes

- `CalendarOccurrence` now has the meaningful identities `sourceItemId`, `occurrenceId` and optional `projectionIdentity`; it no longer duplicates `sourceItemId` as an `id` field. One-off repository occurrences use stable `item:<sourceItemId>` occurrence identity even when moved.
- The generic action authority flag is `canInvokeActions` (not the earlier inline-specific name) because it governs inline, details and context actions consistently. `canEdit` means semantic edit authority; schedule-only movement/resizing remains expressed by the dedicated temporal capabilities.
- Presentation-extension CSS is cosmetic-only, scoped beneath Calendar, and fails closed on geometry declarations, malformed scope-breaking selectors or `!important`; add-on CSS is scoped to its add-on wrapper, permits a conservative responsive `@media` subset, and cannot use `!important`. Host decoration data is emitted only as `data-host-*`. Calendar geometry is not a host CSS API.
- `handleCreate` / `handleEdit` fall-through opens the built-in mutation editor only when an actual Calendar command path exists.
- The published npm package contains production `dist`, docs and README only; demos, fixtures, tests and TypeScript sources remain repository/development assets.

## Sandboxes

- `demo/generic.html` proves bare `core + view` with travel/notes/personal-style host data and no optional personal/planning feature.
- `demo/index.html` opts into the Director adapters, fixtures and planning extension.

Study Director, Revision Director and Practice Desk are included only as current adapter examples/consumers. Ayana-, notes-, task-, finance- or other application-specific semantics belong in their own adapters/features, not the kernel.

## Development

Use the repository-pinned toolchain:

```bash
nvm use
npm ci
npm run check
```

The normal quality gate is strict TypeScript typechecking, the complete non-visual test suite, and package-content validation. Screenshot/browser-gallery QA is intentionally separate from routine QA.

The permanent suite covers recurrence/DST, series edits, view-range/list grouping, resize geometry and recurring resize commands, source and item authority, fail-closed undo/redo under concurrent changes, persistence invariants, generic host semantics, optional-feature boundaries, temporal-preserving edits, interoperability/reminders and the optional Director integrations. Screenshot/browser-gallery QA is intentionally separate from routine QA and can be run explicitly for visual release checks.

See:

- `docs/ARCHITECTURE.md` — canonical generic architecture contract;
- `docs/AYANA_INTEGRATION.md` — Ayana-as-host integration architecture and target calendar experience;
- `docs/AYANA_IMPLEMENTATION_PROGRAMME.md` — staged Calendar + Ayana implementation programme and acceptance gates.
- `docs/BACKGROUND_RANGES_PROGRAMME.md` — generic passive background-range architecture and staged availability programme.
