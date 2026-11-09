# Director Calendar

Release candidate: **1.0.0-rc.9**.

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
- provide source actions such as open/start/launch/custom;
- provide display icon/color/text/class metadata;
- attach optional UI extensions such as planning presentation;
- use a read-only snapshot provider when the host owns persistence/commands elsewhere, or a mutable repository when Calendar owns writes; projected host data can publish invalidations without transferring ownership;
- map ICS/Google imports to host-defined ownership/kind/edit policy while interoperability identity stays namespaced under `metadata.calendarInterop`;
- use custom reminder delivery-channel identifiers in addition to the built-in browser/in-app/external conventions.

The base view treats host metadata as opaque and does not infer categories or application semantics from it. Custom reminder channels can be supplied to the editor, and an existing unknown channel is preserved during editing.

The built-in editor preserves temporal meaning: zoned events edit in their own IANA timezone, floating events remain wall-clock values, instant events remain instants, and all-day values remain date-only. Drag/drop and keyboard conversions between all-day and timed placement update start/end, precision and temporal representation atomically rather than leaving mixed state. Recurrence controls cover the common daily/weekly/monthly/yearly patterns and expose the engine's month-day, month, RFC-style weekday/ordinal and set-position filters behind an advanced disclosure. Unchanged recurrence rules are preserved exactly; split-series edits preserve the remaining count and remap only surviving tail exceptions.

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
