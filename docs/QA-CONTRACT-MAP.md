# Calendar QA — canonical contract map (Pass A)

> **Immutable audit snapshot:** `working` at [`20f06c826f37`](https://github.com/oneshubhamt/calendar/tree/20f06c826f37f271267520ccd57811d8ada6124b), 2026-11-14. **Audit only:** production, tests, and workflows are unchanged. Re-map ordinals after edits to test declarations. This is a *census and consolidation decision record*, not a replacement for the tests.

## Scope, rules and counts

- `25` Node `.test.mjs` modules, `212` top-level Node cases; `5` Playwright `.spec.mjs` modules, `55` unique browser scenarios; `9` named screenshot baselines associated with the visual scenarios.
- Chromium runs all 55 browser scenarios; Firefox and WebKit run 46 each (the nine visual cases are Chromium-only): **147 browser executions**, not 147 unique scenarios.
- Mutually exclusive, *primary* classification: **E 174** = essential correctness / independent failure witness; **C 79** = complementary variation or second layer of a useful contract; **R 2** = *overlap candidate*, not proved redundant in all assertions; **I 3** = implementation-/shape-oriented: review whether a behaviour or packaging contract can replace it; **D 9** = deep, exhaustive or stress/boundary witness worth tiering separately. None of R/I implies permission to delete.
- Exact identification is `file:#`: 1-based **top-level `test()` declaration order at the pinned commit**, not browser execution order or `test.step` count. Each case below has a single primary **classification/risk** tag, such as `04:E/M`. Scenario names and detailed assertions remain in the linked frozen source. Multi-risk scenarios are assigned their dominant risk; secondary evidence is preserved in the test.
- Classification decisions reflect inspected test bodies in representative overlap and boundary cases plus an exhaustive inspection of the declaration titles / suite topology. Individual assertion equivalence has **not** been proved for every potential overlap; Pass B/C must verify before removal.

## Risk → invariant → cheapest trustworthy witness

| Risk | Failure being prevented / invariant | Cheapest appropriate evidence and independent witness |
|---|---|---|
| **X** Architecture / package | Generic kernel stays isolated; optional features are opt-in; exported `dist` files are valid | One resolved TypeScript dependency-graph assertion plus exported-package inspection and real clean package build, not repeated source-regex tests |
| **H** Host / generic contracts | Calendar does not invent host semantics or unauthorized persistence; extension interfaces remain generic | Headless host-shape contract tests; actual host/provider contract tests where possible; one browser integration journey only for DOM behavior |
| **T** Civil/zone time | Correct local date, gap/overlap treatment, snap and calendar arithmetic | Independent civil-time boundary oracle, explicit known-zone transitions and metamorphic laws; exhaustive 400-year reference check in deep tier |
| **R** Recurrence / series | Occurrence identity, count/ordinal, exceptions, range partition and editing are stable | Explicit expected-date oracle + partition/inverse properties + series mutation state tests; do not treat two functions sharing production logic as independent witnesses |
| **L** Layout / views | Correct clipping, ordering, lanes, geometry, print/view range | Headless geometry invariants and permutations; few DOM/visual witnesses for browser-specific clipping |
| **P** Placement / interaction | Half-open intervals, navigation/availability guards, collision and drag/resize policy | Finite interval oracle, headless policy matrices, one user-facing browser mutation path per materially different interaction |
| **A** Authority | Default and trusted-host permission changes are fail-closed; execution rechecks permission | Node capability/decision table plus browser denied/allowed action path |
| **M** Mutation / undo | Atomic single authoritative commit, CAS, correct staged history and committed-vs-refresh-failed outcomes | Modelled state transitions and injected failures; DOM only where actual interaction commits |
| **O** Projections / invalidation | Range, source and occurrence identity correct; background work separate; stale refresh cannot win | Node provider scheduling/identity cases; browser refresh for observable DOM results |
| **D** Browser storage | IndexedDB schema, commit/reopen, stale revision, two-tab convergence, foreground fallback correct | Real IndexedDB + multi-tab Playwright; Node memory store is complementary, not a substitute |
| **I** Interoperability | ICS round-trip, reminders exactly-once claim, sync conflicts/idempotency/checkpoint recovery | Node table and failure-injected fake transport; genuine external Google service contract requires separate authorized integration evidence |
| **S** Resource scheduling | Hierarchy, assignments, availability, scoped collisions, diagonal atomic mutation correct | Headless normalization/placement invariants + one real browser resource journey per layout variant |
| **U** User-facing UI | Navigation, keyboard/pointer, accessible actions, disposal, no visual state regressions | Playwright semantic locators and observable user outcomes; DOM implementation probes only when the DOM contract itself matters |
| **V** Visual appearance | Selected viewport, DST, print and resource surfaces remain readable and unclipped | Nine reviewed screenshot baselines **only**; never substitute screenshots for functionality/accessibility assertions |

## Exact case census

Each token `NN:class/risk` corresponds to exactly one source test at the pinned commit. This compact enumeration deliberately avoids duplicating 267 long test titles that already live in source.

| Source (frozen link) | Cases | Ordered case classifications |
|---|---:|---|
| [`architecture-guards.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/architecture-guards.test.mjs) | 7 | 01:E/X 02:E/X 03:E/X 04:C/X 05:E/X 06:C/X 07:I/X |
| [`core.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/core.test.mjs) | 28 | 01:C/M 02:E/R 03:E/A 04:E/M 05:C/T 06:C/H 07:E/R 08:E/A 09:E/R 10:E/O 11:C/L 12:C/L 13:E/P 14:R/O 15:E/P 16:C/T 17:E/D 18:E/M 19:E/D 20:E/O 21:E/M 22:C/M 23:E/M 24:E/M 25:C/M 26:C/M 27:E/M 28:E/O |
| [`custom-view.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/custom-view.test.mjs) | 3 | 01:E/H 02:C/H 03:C/H |
| [`embedded-navigation.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/embedded-navigation.test.mjs) | 4 | 01:E/P 02:E/P 03:C/O 04:E/P |
| [`external-drop.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/external-drop.test.mjs) | 3 | 01:E/P 02:E/P 03:C/H |
| [`genericity.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/genericity.test.mjs) | 21 | 01:E/H 02:E/H 03:E/H 04:C/H 05:C/H 06:C/H 07:C/I 08:E/A 09:E/H 10:R/X 11:I/X 12:C/X 13:E/O 14:E/O 15:C/O 16:C/T 17:C/R 18:C/O 19:E/A 20:E/P 21:C/P |
| [`host-adapter-contracts.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/host-adapter-contracts.test.mjs) | 4 | 01:E/H 02:E/H 03:E/O 04:C/U |
| [`integration.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/integration.test.mjs) | 4 | 01:C/H 02:E/M 03:E/H 04:E/M |
| [`interoperability.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/interoperability.test.mjs) | 16 | 01:E/I 02:E/I 03:E/I 04:C/I 05:E/I 06:E/I 07:C/I 08:E/I 09:E/I 10:E/I 11:E/I 12:E/I 13:E/M 14:C/I 15:E/I 16:C/I |
| [`mathematical-invariants.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/mathematical-invariants.test.mjs) | 6 | 01:D/T 02:D/R 03:D/L 04:D/P 05:D/S 06:E/I |
| [`multi-month.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/multi-month.test.mjs) | 4 | 01:C/L 02:E/L 03:C/U 04:C/H |
| [`occurrence-authority.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/occurrence-authority.test.mjs) | 18 | 01:E/A 02:E/A 03:E/A 04:E/A 05:E/A 06:E/A 07:E/O 08:E/M 09:E/M 10:E/A 11:E/M 12:C/M 13:C/M 14:C/L 15:E/M 16:E/M 17:E/M 18:C/M |
| [`occurrence-projection.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/occurrence-projection.test.mjs) | 14 | 01:E/O 02:C/R 03:E/O 04:E/O 05:E/O 06:E/O 07:E/O 08:C/O 09:C/O 10:E/O 11:E/O 12:E/O 13:C/O 14:E/T |
| [`point-temporal-layout.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/point-temporal-layout.test.mjs) | 8 | 01:E/T 02:E/R 03:E/O 04:E/L 05:C/L 06:E/A 07:C/L 08:E/T |
| [`resource-availability.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/resource-availability.test.mjs) | 6 | 01:E/S 02:E/S 03:E/O 04:E/P 05:C/S 06:C/P |
| [`resource-scheduler-integrity.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/resource-scheduler-integrity.test.mjs) | 4 | 01:E/S 02:E/S 03:E/S 04:D/S |
| [`resource-scheduler-interaction.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/resource-scheduler-interaction.test.mjs) | 5 | 01:E/S 02:E/T 03:E/P 04:E/M 05:C/M |
| [`resource-scheduler-layout.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/resource-scheduler-layout.test.mjs) | 6 | 01:E/L 02:C/L 03:C/T 04:C/L 05:C/S 06:E/T |
| [`resource-scheduler-placement.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/resource-scheduler-placement.test.mjs) | 12 | 01:E/S 02:E/P 03:E/P 04:E/A 05:E/M 06:E/M 07:E/M 08:E/S 09:E/R 10:E/O 11:E/T 12:E/M |
| [`resource-time-grid-layout.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/resource-time-grid-layout.test.mjs) | 7 | 01:E/L 02:C/T 03:E/T 04:E/L 05:C/L 06:E/S 07:E/S |
| [`secondary-time-zone.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/secondary-time-zone.test.mjs) | 6 | 01:C/T 02:E/T 03:E/T 04:E/T 05:C/T 06:E/T |
| [`structured-presentation.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/structured-presentation.test.mjs) | 5 | 01:E/U 02:E/U 03:I/U 04:E/U 05:E/L |
| [`timeline.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/timeline.test.mjs) | 6 | 01:E/L 02:C/L 03:E/T 04:C/L 05:C/L 06:C/H |
| [`view-capabilities.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/view-capabilities.test.mjs) | 12 | 01:E/L 02:E/L 03:E/R 04:E/R 05:E/T 06:E/T 07:C/R 08:C/L 09:C/L 10:E/P 11:E/P 12:E/R |
| [`week-numbering.test.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/week-numbering.test.mjs) | 3 | 01:D/T 02:E/T 03:C/U |
| [`browser/rendering-smoke.spec.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/browser/rendering-smoke.spec.mjs) | 18 | 01:E/U 02:E/O 03:E/O 04:E/U 05:E/P 06:E/U 07:E/T 08:E/H 09:E/U 10:C/L 11:E/P 12:E/P 13:C/P 14:C/H 15:E/U 16:C/L 17:C/U 18:C/H |
| [`browser/resource-scheduler.spec.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/browser/resource-scheduler.spec.mjs) | 7 | 01:E/S 02:E/M 03:E/O 04:C/O 05:E/P 06:E/U 07:D/U |
| [`browser/resource-time-grid.spec.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/browser/resource-time-grid.spec.mjs) | 5 | 01:E/S 02:E/M 03:E/T 04:E/P 05:E/P |
| [`browser/storage.spec.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/browser/storage.spec.mjs) | 16 | 01:E/D 02:E/D 03:E/D 04:E/D 05:E/I 06:E/I 07:C/D 08:E/D 09:E/D 10:E/D 11:E/D 12:E/D 13:E/D 14:E/D 15:E/D 16:E/D |
| [`browser/visual.spec.mjs`](https://github.com/oneshubhamt/calendar/blob/20f06c826f37f271267520ccd57811d8ada6124b/tests/browser/visual.spec.mjs) | 9 | 01:C/V 02:C/V 03:C/V 04:D/V 05:C/V 06:C/V 07:C/V 08:C/V 09:C/V |

### Visual reference-image census

All nine snapshots are committed under `tests/browser/__screenshots__/` and exercised by `tests/browser/visual.spec.mjs` in this exact order:

| Visual case | Baseline | Class | Witness |
|---|---|---|---|
| 1 | `week-desktop.png` | C/V | Week layout geometry and readability |
| 2 | `month-desktop.png` | C/V | Month cell/overflow presentation |
| 3 | `day-narrow.png` | C/V | Narrow timed-view clipping |
| 4 | `day-dst-fallback.png` | D/V | Folded hour geometry / labels |
| 5 | `multi-month-desktop.png` | C/V | Composed panel sizing |
| 6 | `multi-month-narrow.png` | C/V | Responsive composition |
| 7 | `timeline-desktop.png` | C/V | Horizontal event lanes |
| 8 | `print-multi-month.png` | C/V | Detached print snapshot |
| 9 | `resource-time-grid-desktop.png` | C/V | Resource column geometry |

## Measured baseline and cost concentration

**Observed on successful GitHub Actions runs for the audited commit**, not estimated from test count:

| QA lane | Observed result / execution cost | Measurement method |
|---|---|---|
| Node `npm test` test runner | **212/212** pass; **4,071.4 ms** reported by `node --test` | [CI run 43553187188](https://github.com/oneshubhamt/calendar/actions/runs/43553187188) |
| Browser `npm run qa:browser` test runner | **147/147** pass, **1.7 min (~100.6 s)** | [Browser run 43553187192](https://github.com/oneshubhamt/calendar/actions/runs/43553187192), start/end log timestamps |
| Browser Chromium | 55 scenarios, ~21.2 s | Sum of elapsed intervals between scenario-start timestamps, includes some per-case overhead |
| Browser Firefox | 46 scenarios, ~35.2 s | Same |
| Browser WebKit | 46 scenarios, ~43.8 s | Same |
| Browser `rendering-smoke.spec.mjs` | 18 unique cases, ~45.8 s across 3 engines | 9.6 + 16.4 + 19.8 s approximately |
| Browser `storage.spec.mjs` | 16 unique cases, ~28.9 s across 3 engines | 3.4 + 10.6 + 14.9 s approximately |

Node's four strongest cost centres (per-case runner durations; overlaps under concurrent test execution are possible): `mathematical-invariants:#1` civil+snap **2,482 ms**; `week-numbering:#1` independent 400-year ISO oracle **784 ms**; `architecture-guards:#1` TypeScript resolution graph **653 ms**; `mathematical-invariants:#2` recurrence partition/ordinal **503 ms**. These are valuable witnesses, not automatic deletion candidates.

Current `npm run check` runs `npm test` (which builds `dist`) and `npm pack --dry-run` (which invokes `prepack` and rebuilds through `build:package`); separate browser QA builds again on its own workflow. Preserve package correctness while measuring whether compilation can be shared **within** a job. Browser CI uses one worker and repeats four complete specs in Firefox and WebKit; nine visuals are Chromium-only.

The workflow elapsed time includes checkout, pinned npm/Node setup and dependency installation. No local timing/memory/flake-rate measurements were made; GitHub Actions timing is the baseline, not a benchmark prediction.

## Evidence-backed consolidation decisions (no deletion in Pass A)

1. **Protect independent mathematical witnesses.** The finite half-open interval oracle (`mathematical-invariants:#4`), 400-year independently modelled week numbers (`week-numbering:#1`), and explicit exact-date availability examples (`genericity:#15`) give different kinds of evidence. Retain them. Civil+snap and recurrence test cost suggests splitting everyday boundary examples from exhaustive/metamorphic stress in a later pass only after correctness and mutation sensitivity are shown.
2. **Two partial overlaps to reconcile assertion-by-assertion.** `core:#14` and `occurrence-projection:#13` both verify event-only queries skip background providers, but the former additionally tests a *throwing* background provider and explicit full-query failure, while the latter tests concurrent item/occurrence providers. Preserve both independent failure paths if merged. `genericity:#10` and `architecture-guards:#2` both verify absence of optional root exports; their tested symbol sets differ. Consolidate into one root export contract matrix **only after unioning the assertions**. Neither is safe to simply delete.
3. **Review three shape-oriented checks, not all architecture checks.** `architecture-guards:#7` currently pins the exact `package.files` array and target-string shapes; `genericity:#11` checks absence of one historical compiled filename; `structured-presentation:#3` tests a menu-default/opt-in state using an implementation-specific “C4” label. Replace weak source-shape aspects with actual package-publication and UI-state contracts; retain any distinct semantic assertions.
4. **Keep cross-layer evidence when failure domains differ.** Node memory CAS is not real IndexedDB multi-tab CAS; headless resource atomicity is not a pointer/keyboard commit; CSS snapshots cannot prove accessible action behavior. Preserve these witnesses even if they appear to test similar features.
5. **Do not let file-based browser selection dictate cross-engine breadth.** `playwright.config.mjs` repeats 46 unique cases in each non-Chromium engine. Build case-level tags / a scenario registry and select high-risk engine-dependent storage, DST, keyboard/pointer and resource journeys for fast QA; keep the full 147-execution matrix for release. Measure selected and full lanes before declaring savings.
6. **Refactor the 1,982-line rendering smoke monolith.** Its 18 cases span unrelated refresh, UI, external drop, custom views and print responsibilities and have many `page.evaluate` / CSS-selector probes. Split by user-facing contract; keep genuine internal port probes only where required. Replace fixed waits with observable readiness where possible.
7. **Treat fixtures as contracts only within their scope.** `host-adapter-contracts` uses representatives of host “working shapes”; `interoperability` uses controlled transport faults. They do **not** by themselves establish live Study Director/Practice Desk or Google provider compatibility. Actual provider integration remains a separate acceptance question, not a reason to multiply shallow mocks.
8. **Keep visual QA deliberately small.** Nine reference images cover nine distinct surfaces, but should not be run as a proxy for semantic behavior or used to require pixel parity where browser/font differences dominate. Require human review for updates.
9. **Do not remove a test because its name or assertion looks similar.** Demonstrate the alternative witness: input/trigger, expected state/output, failure path, and detection of a realistic injected defect. Only then consolidate.

## Reconciliation and Pass B/C acceptance

- **Mapped:** 25 Node files / 212 source-order test IDs; five browser files / 55 source-order scenario IDs; nine screenshot files; 147 observed browser executions. No case is unclassified.
- **Class totals:** E **174**, C **79**, R **2**, I **3**, D **9** = **267**. R denotes *potential partial overlap*, not a finding of a proven expendable test.
- **Measured CI:** Node and browser both green on the pinned source; those runs predate this documentation-only commit. Browser costs are measured in existing CI, no local rerun claimed.
- **Pass B/C must preserve:** all E contracts; the unique parts of every C/R/I contract; executable deep witnesses available in a separate lane; and real-browser multi-tab, DST, atomic resource mutation and accessibility evidence.
- **Verification required after consolidation:** executable inventory counts; invariant-to-witness matrix reconciliation; clean typecheck/build/package; targeted browser journeys; full three-engine QA; before/after wall-clock timings. Delete nothing without another test proving the same invariant and failure mode.

## Pass B — Node consolidation (2026-11-14)

**Implementation source:** [`qa-node-pass-b`](https://github.com/oneshubhamt/calendar/tree/qa-node-pass-b), to be fast-forwarded to `working` after validation. The exhaustive Pass A census above remains **immutably anchored** to its original commit; this section is the crosswalk to the canonical replacement tree.

### Current product-domain ownership

| Node domain directory | Modules | Test cases | Contract ownership |
|---|---:|---:|---|
| `tests/node/architecture/` | 1 | 7 | Dependency direction, package surface |
| `tests/node/engine/` | 2 | 45 | Repository, mutation/undo, occurrence authority |
| `tests/node/host/` | 3 | 27 | Generic contracts, host integrations/adapters |
| `tests/node/interop/` | 1 | 17 | ICS, Google sync, reminders, independent sync decision model |
| `tests/node/projection/` | 1 | 14 | Occurrence/provider behavior and background-query isolation |
| `tests/node/resources/` | 6 | 41 | Hierarchy, normalization oracle, availability, geometry, atomic placement |
| `tests/node/temporal/` | 4 | 23 | Time/DST, recurrence, overlap, ISO week numbers |
| `tests/node/view/` | 7 | 37 | Navigation, extensions, optional views, editor/placement presentation |
| **Total** | **25** | **211** | All risk domains from Pass A retained |

Tests are discovered by `tests/run-node.mjs` using Node's cross-platform `globSync`, rather than a shell-specific nonrecursive wildcard. Shared immutable domain objects remain in `tests/fixtures/domain.mjs`; independent Gregorian day-scan, civil constants and permutation combinatorics live in `tests/fixtures/reference-temporal.mjs` and `tests/fixtures/combinatorics.mjs`. Do not import production algorithms into these reference helpers.

**Case reconciliation:** original **212**, remove three superseded case declarations, add two independent recurrence-oracle cases = **211**. The unchanged 208 cases retain their inputs/assertions (apart from relative import adjustments and moving two existing mathematical cases into their owning modules); one existing stale-revision test was strengthened into a multi-step reference state machine.

| Superseded case | Independent contract kept in |
|---|---|
| `genericity:#10` root optional-exports | `tests/node/architecture/guards.test.mjs`: union of all forbidden root symbols + optional path contracts |
| `genericity:#11` one stale `dist/core/personal.js` filename | canonical clean build + `npm pack --dry-run` and actual export-target existence checks |
| `core:#14` event-only background skip/throw | `tests/node/projection/occurrences.test.mjs`: concurrent projected item/occurrence providers, skipped throwing background provider, full-query failure |
| `core:#19` single stale CAS attempt (replaced in place) | `tests/node/engine/core.test.mjs`: independent accepted/stale/future transition table with state invariant after each attempt |

New independent temporal cases combine a UTC date-scanning oracle (daily/biweekly across leap-year and year boundaries) with explicit **known** month-end, leap-day, New York DST and Lord Howe 30-minute rollback instants. Existing ordinal/partition metamorphic tests and the 400-year independent week-number oracle remain intact. Existing resource permutation invariants and Google sync decision matrices are relocated, not removed.

**Measured validation:** baseline `working` (212 pass, **4.071 s** Node test runner); first staged run [43569572707](https://github.com/oneshubhamt/calendar/actions/runs/43569572707) (211 pass, **3.190 s**); consolidated-domain run [43569832277](https://github.com/oneshubhamt/calendar/actions/runs/43569832277) (211 pass, **3.441 s**). Both staged runs passed clean build, Node QA and packaging. Differences are observed CI timing, not statistically demonstrated speedup. Browser specs and `src/` are untouched. Pass C/D own browser selection and workflow economics.

**Future change rule:** Move or remove a test only after the precise risk and its unique failure-mode witness are accounted for in the owning domain. Avoid growth of parallel architecture-guard and legacy-syntax test files.

## Pass C — Browser suite consolidation (2026-11-14)

**Source:** `working`, applied from temporary `qa-browser-pass-c` after staging CI, smoke and full-release verification. Pass A's original case IDs and snapshots are preserved, not rewritten.

### Product-owned suites and selection contracts

| Source directory / spec | Unique scenarios | Contract owner |
|---|---:|---|
| `tests/browser/rendering/refresh.spec.mjs` | 3 | Clock rollover, concurrent refresh, failed projection recovery |
| `tests/browser/rendering/interaction.spec.mjs` | 5 | Week geometry, drag, presentation actions, DST, week-number UI |
| `tests/browser/rendering/custom-views.spec.mjs` | 4 | Host view protocol, Multi-Month, Timeline, disposal |
| `tests/browser/rendering/external-drop.spec.mjs` | 2 | External/host drop authority and opt-in |
| `tests/browser/rendering/print.spec.mjs` | 2 | Detached print and view coverage |
| `tests/browser/rendering/embedded.spec.mjs` | 2 | Host-contained styling and overdue extension |
| `tests/browser/storage/schema.spec.mjs` | 4 | Canonical IndexedDB schema and interop metadata rejection |
| `tests/browser/storage/lifecycle.spec.mjs` | 5 | Single-flight open, close/reopen, stale reload generation |
| `tests/browser/storage/records.spec.mjs` | 2 | Actual IDB item/source CRUD and persistence |
| `tests/browser/storage/concurrency.spec.mjs` | 5 | Cross-tab reminder/google claims, CAS, BroadcastChannel/focus recovery |
| `tests/browser/resource-scheduler.spec.mjs` | 7 | Horizontal resource UI and atomic host actions |
| `tests/browser/resource-time-grid.spec.mjs` | 5 | Vertical resource UI and diagonal mutations |
| `tests/browser/visual.spec.mjs` | 9 | Reviewed screenshot baselines |
| **Total** | **55** | 13 independent spec modules |

`tests/browser/scenario-registry.mjs` owns exactly 55 stable IDs and their suite tags. `scenario()` rejects missing/duplicate IDs; no test depends on a filename or positional tag. `tests/browser/support/harness.mjs` centralizes harness navigation. Existing storage helpers and visual mount fixture remain shared. Storage tests now import only their required helper functions. All 55 original test titles and scenarios remain; no browser test has been deleted.

| Lane | Command | Chromium | Firefox | WebKit | Total executions |
|---|---|---:|---:|---:|---:|
| **Smoke (routine working/working-targeted PR)** | `npm run qa:browser:smoke` | 25 | 14 | 14 | **53** |
| **Cross-engine focused** | `npm run qa:browser:cross` | 14 | 14 | 14 | **42** |
| **Visual** | `npm run qa:browser:visual` | 9 | — | — | **9** |
| **Full release (unchanged matrix)** | `npm run qa:browser` | 55 | 46 | 46 | **147** |

Each scenario always has `@release`, with selective `@cross`, `@smoke`, or `@visual`. The 14 cross cases target temporal/DST, pointer, custom-view, external drop, print, resource atomicity, IndexedDB/claims/CAS/focus recovery. Eleven more Chromium-only smoke cases give broader UI and storage coverage. The nine visual cases remain Chromium-only; exact snapshot paths and image files have not changed.

**CI economics:** `.github/workflows/browser-smoke.yml` runs the tagged smoke lane on pushes to `working` and PRs targeting `working`. The existing `browser-release.yml` retains its original triggers for PRs to `main`, pushes to `main`, release tags, and manual dispatch; it runs the complete 147-execution lane. No duplicate smoke job is scheduled for PRs already receiving full release QA. Node CI remains separate and unchanged.

### Behavioural changes versus old tests

- `rendering/interaction` now clicks the presented event through an accessible button name rather than `.dc-occurrence-main` class selection; geometry and visual-layer checks appropriately retain class/structural locators.
- `resource-scheduler` waits for actual drag activation instead of an assumed 300 ms delay. A short cancellation-observation delay and several negative external-drop asynchronous settle windows remain intentionally: eliminating these without a real completion signal could make negative assertions pass prematurely. They are not evidence of a new timing subsystem requirement.
- The six old rendering subgroups and four storage subgroups preserve all scenarios, original provider fault paths, cross-tab conditions, resource interactions and visual coverage. The full three-browser matrix is **not** replaced by the smoke lane.

### Verification and measured economics

| Evidence | Baseline (Pass A) | Pass C staged result |
|---|---|---|
| Node/type/package | 212/212 before Pass B | 211/211 in final Pass B working and staged Pass C CI |
| Full browser matrix | 147/147; ~100.6 sec test phase | [Run 43571116387](https://github.com/oneshubhamt/calendar/actions/runs/43571116387): **147/147; ~87.2 sec** |
| New smoke | Not available | [Run 43571116331](https://github.com/oneshubhamt/calendar/actions/runs/43571116331): **53/53; ~33.8 sec** (Playwright: 34.2 sec incl runner overhead) |
| Case/registry census | 55 unique; nine visual | 55/55 registry IDs used exactly once; nine visual; 13 specs; 0 missing/duplicate IDs |
| Code scope | Original `src/` and production behavior | No `src/` modifications; all five original test domains retained |

Durations are observed on GitHub runners and subject to environmental variation. The reliable economic gain is *selection*: 53 smoke executions instead of 147 full, without discarding the latter. Selection and cross/visual tags are configured but standalone `cross` and `visual` commands are not independently timed; their cases are covered by the successful smoke and full release jobs.

**Pass D:** final gate timing/economics, and compare behavioural/mutation sensitivity of the selected smoke set against full release; do not infer that any single green run proves absence of flakiness.

## Pass D — CI economics, independent verification and objective closure (2026-11-14)

**Final independent staging evidence:** [CI 43575578899](https://github.com/oneshubhamt/calendar/actions/runs/43575578899), [browser smoke 43575578900](https://github.com/oneshubhamt/calendar/actions/runs/43575578900), and [full browser release 43575578930](https://github.com/oneshubhamt/calendar/actions/runs/43575578930) all succeeded. Pass A source baseline `20f06c826f37` remains the immutable census anchor. No production `src/` code changed anywhere in Passes A–D or this closure audit.

### Canonical fast/full execution model

| Lane | Node / package | Browser | Intended trigger |
|---|---|---|---|
| **Fast** | One strict build; **207 routine pass + 4 explicit deep skips**; script-free publication manifest audit | **53** executions: 25 Chromium + 14 Firefox + 14 WebKit | Every ordinary non-`main` push / PR |
| **Full** | All **211/211** Node cases; genuine `prepack`; byte-for-byte publication parity; coverage census | **147/147**: 55 Chromium + 46 Firefox + 46 WebKit, including all nine visual baselines | PR/push to `main`, weekly schedule, release/manual/major-refactor |
| **Focused** | `qa:mutation`: four named compiled-output faults; `qa:coverage`: executable inventory/lane discovery | `qa:browser:cross` = 42; `qa:browser:visual` = 9 | Manual / diagnostic |

The four full-only Node witnesses are deliberately the genuinely expensive exhaustive/stress cases: multi-year civil-day/snap algebra, broad recurrence partition/ordinal metamorphism, complete 400-year ISO-week comparison, and the 12,000-level resource hierarchy stress test. Fast QA **still runs** the cheap independent UTC recurrence oracle, explicit leap/month-end/New York/Lord Howe transition examples, interval finite-lattice model, layout/resource permutations, CAS model and all ordinary failure paths.

### Measured economics

- Before deep tiering, staged fast Node execution was **3.42 s** in run 43572721264. The final closure run executed the same 211 declarations as **207 pass + 4 skip in 2.00 s**; an earlier fast-only closure run measured **1.23 s**. These runner measurements vary, but the selection saving is structural.
- Final closure smoke: [43575578900](https://github.com/oneshubhamt/calendar/actions/runs/43575578900), **53/53 in 34.3 s**. Original Pass A browser phase: **147 in ~100.6 s**.
- Final closure full release: [43575578930](https://github.com/oneshubhamt/calendar/actions/runs/43575578930), **147/147 in ~68.1 s** on that runner; release scope is unchanged.
- Publication audit remains **185 packaged files / 31 export subpaths**, with **182** canonical compiled files byte-identical between the full-development and publication compiler routes.

Durations are observations, not guaranteed benchmarks. The robust gain is that ordinary QA no longer pays for four exhaustive Node witnesses or 94 unnecessary browser-engine repetitions, while full QA still does.

### Independent regression-sensitivity evidence

| Injected defect | Independent intended witness |
|---|---|
| Half-open interval boundary made inclusive | Exhaustive finite interval model |
| Stale revision guard disabled | Multi-transition CAS reference state model |
| Recurrence COUNT leaks one occurrence | Independent UTC civil-date enumeration |
| Prefer-local sync deletion applies remote instead | Local/remote/policy decision table |

**4/4 faults were detected by their named intended tests**, and each modified compiled artifact was hash-verified restored immediately afterward. This is selective mutation evidence, not a claim of exhaustive mutation coverage.

### Browser maintainability closure

- The original 1,982-line rendering file remains split by behaviour; storage remains split by schema/lifecycle/records/concurrency.
- Harness navigation and browser-frame settling are centralized; Resource Scheduler and Resource TimeGrid share one canonical resource-tree fixture.
- There are **zero `waitForTimeout` calls** in the browser QA modules. Negative asynchronous external-drop assertions settle on browser animation frames; pointer cancellation is observed across frames rather than a guessed millisecond sleep.
- User actions use semantic locators where the interaction contract permits; CSS/DOM selectors remain only where geometry, state classes, layout layers or drag targets are themselves the contract.
- The former historical “C4 state” test label is now generic action-state terminology; no compatibility/legacy QA scaffolding remains.

### Final reconciliation against Pass A acceptance criteria

1. **Critical invariants retained:** 25 product-domain Node modules, **211 declared cases**, 13 browser specs, **55 unique scenarios**, nine screenshot baselines. The original 212 Node declarations reconcile as documented in Pass B; no unique failure-path witness was intentionally discarded.
2. **Independent mathematics:** explicit recurrence/date oracles, known DST/leap boundaries, 400-year ISO reference, finite interval model and metamorphic properties coexist; production functions are not used as their own sole oracle.
3. **Important real-browser behaviour retained:** multi-tab IndexedDB/CAS/convergence/focus fallback, resource atomicity in both layouts, host boundaries, pointer/keyboard actions, print/custom views and all visual baselines remain in full release.
4. **Routine QA materially faster:** Node deep tier plus the 53-execution browser smoke lane reduces ordinary work; complete 211/147 coverage remains scheduled/release/manual.
5. **Suite is leaner:** product-domain Node layout, behavioural browser layout, shared fixtures, no fixed-time browser sleeps, one module-graph architecture contract, and no obsolete compatibility checks.
6. **Complete validation:** final staged full Node/package/coverage/mutation gate passed; smoke passed all three engines; full release passed **147/147** across Chromium, Firefox and WebKit.

**Programme closure:** the requested QA architecture is now implemented end to end. Future changes should add or move tests only when a new risk/invariant requires evidence, not to preserve development-history file structures or assertion counts.


## Pass E — evidence-quality and redundancy audit (2026-11-14)

**Audit source:** `working@63e2aff9bcea72313dd16716088d9fb884661dc2`. This pass is audit-only: no production source, test, fixture, workflow or package behaviour is changed. The purpose is to identify the cheapest trustworthy witness for each invariant before Pass F removes or combines anything.

### Measurement basis and interpretation

Executable timings come from the final staged evidence already recorded for the current test tree:

- CI run **43575578899**, job **132388952774**: fast Node lane **211 declarations = 207 pass + 4 deep skips in 1,999.3 ms**; full Node lane **211/211 in 6,215.9 ms**.
- Browser release run **43575578930**, job **132388971781**: **147/147** executions in the Playwright-reported **1.1 min**. Sequential start-to-next-start intervals attribute approximately **14.519 s Chromium + 23.883 s Firefox + 29.485 s WebKit = 67.887 s** to scenario execution/transition time.
- Node per-file numbers below are sums of the runner-reported per-case durations. Node files execute concurrently, so sums are **cost concentration**, not additive wall-clock time.
- Browser per-scenario numbers below are approximate elapsed intervals from a scenario start to the next scenario start in a one-worker release run. They include small runner/transition overhead and must not be read as stable microbenchmarks.

### Invariant-level evidence inventory

The unit of inventory is the **invariant / failure mode**, not the historical test declaration. Witness labels classify the evidence as **behavioural (B), mathematical (M), integration (I), security/authority (S), architecture (A), presentation (P), or superficial (Q)**.

| ID | Invariant / failure prevented | Canonical witness(es), with evidence class | Audit judgement |
|---|---|---|---|
| A1 | Core and view dependency direction stays generic and inward-only | **A:** `node/architecture/guards` module-graph dependency test | Strong, independent architecture witness; keep |
| A2 | Optional Resource Scheduler/TimeGrid/availability/drop boundaries remain opt-in and one-way | **A:** `guards` optional-island + one-way-boundary tests | Keep; graph evidence is cheaper and stronger than source-word checks |
| A3 | Google transport/mapping/sync layers do not collapse into a coupled module | **A:** `guards` Google dependency test | Keep |
| A4 | Durable browser persistence uses one canonical database substrate | **A:** `guards` storage dependency test; **I:** browser `storage.schema` physical topology | Keep both: import topology and real IndexedDB topology fail differently |
| A5 | Optional public features remain explicit subpaths and do not leak into the root API | **A:** `guards` explicit export/root-boundary matrix; **A/I:** package audit resolves actual archive targets | Keep semantic subpath/root boundary; remove duplicate target-shape checks listed below |
| A6 | Published package contains production outputs only and every declared export resolves | **A/I:** `tests/qa/package-audit.mjs` actual `npm pack --dry-run` manifest + full/package compiler byte parity | Canonical publication witness |
| M1 | Civil-day arithmetic is reversible at unambiguous times and snapping obeys floor/round/ceil laws | **M:** `temporal/mathematical-invariants` deep civil/snap algebra | High-value deep witness; keep full-only |
| M2 | Recurrence expansion is partition-invariant, unique, ordered and ordinal/identity invertible | **M:** deep recurrence metamorphic test | Keep full-only |
| M3 | Recurrence agrees with an independent date enumeration and known leap/month-end/DST instants | **M:** UTC reference recurrence + explicit New York/Lord Howe/leap cases | Strong independent oracle; keep routine |
| M4 | Interval collision uses the half-open model, including boundary symmetry | **M:** exhaustive finite-lattice interval oracle | Keep; mutation-proven |
| M5 | Timed layout is permutation-invariant and overlapping intervals never share a temporal lane | **M:** layout permutation/metamorphic test | Keep |
| M6 | ISO week identity matches Gregorian rules over a complete 400-year cycle | **M:** independent ISO reference oracle | High-value deep witness; keep full-only |
| M7 | Point events remain true zero-duration instants through recurrence, range filtering, grouping and layout | **M/B:** `temporal/point-layout` cases | Keep; distinct point semantics |
| M8 | DST gaps/overlaps and secondary time scales preserve civil geometry without inventing instants | **M/P:** point civil-timeline + secondary-time-zone cases | Keep; headless geometry/label semantics |
| M9 | Resource hierarchy normalization is deterministic, permutation-invariant and stack-safe | **M/B:** `resources/integrity` permutation + deep hierarchy tests | Keep; deep stack witness remains full-only |
| M10 | Resource horizontal/time-grid layouts clip, lane and map resources deterministically across DST | **M/P:** `resources/layout`, `time-grid-layout` | Keep; two independently implemented surfaces |
| M11 | Navigation, view ranges, recurrence-editor conversions and Multi-Month/Timeline ranges obey calendar arithmetic | **M/B:** `view/capabilities`, `navigation`, `multi-month`, `timeline` | Keep; consolidate fixtures only if useful |
| B1 | Canonical value comparison and repository snapshots are deterministic and ownership-safe | **B:** `engine/core` canonical-value + immutability tests | Keep |
| B2 | Repository commands commit atomically under revision guards; stale proposals never partially apply | **B:** `engine/core` command commit + independent CAS state model | Keep; mutation-proven |
| B3 | Undo/redo owns only its delta, preserves unrelated changes and fails closed on affected concurrent changes | **B:** `engine/core` undo/redo family | Keep unique failure modes; candidate for table-driven consolidation, not deletion |
| B4 | Series edit/split semantics preserve anchors, temporal representation and surviving exceptions | **B/M:** `engine/core` series cases | Keep |
| B5 | Background/projected data remains passive, identity-safe, range-bounded, concurrent where intended and invalidation-aware | **B:** `engine/core` background cases + `projection/occurrences` | Keep; prior true duplicate already removed in Pass B |
| B6 | Engine invalidation generation is distinct from durable revision and subscriber failures cannot corrupt commits | **B:** `engine/core` revision/subscriber cases | Keep |
| B7 | Browser refresh coalesces bursts, drains a newer request after failure and does not let a superseded request win | **I/B:** browser `refresh.*` | Keep real async/browser integration |
| B8 | IndexedDB lifecycle is single-flight, close/open race-safe and generation-safe | **I/B:** browser `storage.single-flight`, `close-open`, `reopen-race`, `reopen`, `reload-generation` | Keep distinct lifecycle triggers; merge setup only |
| B9 | IndexedDB CRUD persists canonical item/source transitions across repository instances | **I/B:** `storage.persist-reopen` + `storage.crud` | Partial overlap only; persistence and source/error semantics differ |
| S1 | Baseline occurrence authority preserves full/schedule-only/readonly policy | **S:** `engine/occurrence-authority` baseline matrix | Keep |
| S2 | Default capability providers may narrow but not widen; trusted hosts may widen only explicitly | **S:** occurrence-authority capability matrix | Keep |
| S3 | Capability revocation, malformed values and provider failures fail closed at execution time | **S:** occurrence-authority dynamic/failure cases | Keep |
| S4 | Mutation lifecycle distinguishes rejection/stale from a committed mutation whose refresh fails | **S/B:** occurrence-authority lifecycle/coordinator cases; **I:** browser resource failure scenarios | Keep both: headless state machine and rendered host outcome |
| S5 | Generic placement combines bounds, warnings, collision and authority without silent writes | **S/B:** `engine/core` placement + `view/capabilities` | Keep |
| S6 | Resource placement validates assignments, requires only changed-dimension authority and commits diagonal changes atomically | **S/B:** `resources/placement` | Keep |
| S7 | External drop is opt-in, bounded and authority-mediated; malformed/custom decoders fail closed | **S/B:** Node external-drop decoder contracts; **I/S:** browser `drop.authorized`, `drop.opt-in` | Keep cross-layer evidence |
| S8 | Host metadata/source removal/projected identity do not acquire implicit authority | **S/B:** generic-contract metadata/removal + projection integrity cases | Keep behavioural rules; remove historical naming probes |
| I1 | Study/Revision/Practice host working shapes are adapted host-side and do not leak host storage semantics into Calendar | **I:** `host/adapter-contracts` | Keep |
| I2 | Director ecosystem fixtures, write-back and source actions use the canonical integration ports | **I:** `host/integration` | Keep |
| I3 | ICS/Google/reminder sync is idempotent under retry, checkpoint failure, conflict, deletion and concurrent claims | **I/B:** `interop/contracts` | Keep; controlled transport faults are intentional |
| I4 | Real IndexedDB enforces canonical schema, rejects malformed persisted interop records and canonicalizes timestamps/identity | **I:** browser `storage.schema*`, `interop-*` | Keep; browser-only storage failure domain |
| I5 | Cross-tab CAS, reminder claim, Google lock, BroadcastChannel and foreground fallback converge correctly | **I:** browser `storage/concurrency` | Keep; memory-store tests are not substitutes |
| I6 | Resource Scheduler and Resource TimeGrid keyboard/pointer paths produce one authoritative host mutation and reproject | **I/S:** browser resource scenarios | Keep; browser interaction is the contract |
| I7 | Custom views obey the bounded action port, compose the canonical views and dispose instances | **I/P:** browser `custom.*` | Keep; test-body setup is a consolidation target |
| I8 | Print API produces detached/read-only view coverage rather than mutating the live calendar | **I/P:** browser `print.snapshot`, `print.all-views` | Keep functional print evidence |
| P1 | Structured presentation safely merges text/badges/data/actions and extension failures/CSS cannot seize geometry | **P/B:** Node structured-presentation; **P/I:** browser `presentation.actions` | Keep headless validation + DOM accessibility/action evidence |
| P2 | Week/DST/week-number surfaces expose correct user-visible layers, folded-hour labels and accessible narrow layout | **P/I:** browser `view.week`, `view.dst-fallback`, `view.week-numbers` | Keep; not replacements for mathematical oracles |
| P3 | Embedded host styling and overdue extension remain contained and visible | **P/I:** browser `embed.isolation`, `host.overdue` | Keep |
| P4 | Reviewed visual baselines cover selected week/month/day/DST/Multi-Month/Timeline/print/resource surfaces | **P:** nine visual scenarios | Keep deliberately small; do not use as semantic substitutes |
| Q1 | Exact counts of test files/cases/deep tests/specs/scenarios/screenshots remain frozen | **Q:** `tests/qa/coverage-audit.mjs` exact numeric census | Superficial; remove count pinning in Pass F |
| Q2 | Exact release/smoke/cross/visual execution totals remain 147/53/42/9 | **Q:** coverage-audit Playwright `--list` numeric assertions | Superficial; replace with semantic lane-set assertions |
| Q3 | `package.files` equals one exact array and export target strings start with `./dist/` | **Q/A:** `architecture/guards` package-shape assertions | Redundant with actual package-manifest evidence; remove duplicate shape checks |
| Q4 | Historical root aliases such as `DirectorCalendarEngine`, `DirectorCalendar`, `DIRECTOR_CALENDAR_CSS` remain absent by exact old name | **Q:** generic-contract historical-name negatives | No current product invariant justifies pinning old names; remove negatives |
| Q5 | Availability export path equals the literal string `./dist/features/availability.js` | **Q/A:** generic-contract availability feature case | Duplicate of explicit subpath + actual archive target checks; remove literal path assertion |
| Q6 | Publication tsconfig excludes exactly two literal glob strings | **Q/A:** `package-audit` `config.exclude` equality | Outcome is already proved by byte parity + archive leakage/missing-export checks; remove exact config-shape assertion |

### Apparent overlaps that are **not** duplicates

A test is duplicate only when its **trigger/input, expected invariant and realistic failure mode** are all already witnessed elsewhere. These pairs overlap in subject matter but remain independent:

| Apparent overlap | Why it survives |
|---|---|
| Node 400-year ISO week oracle ↔ browser `view.week-numbers` | Mathematical identity versus ARIA text, opt-in DOM structure and narrow-layout overflow |
| Node DST/civil geometry ↔ browser `view.dst-fallback` | Headless civil-time arithmetic versus actual folded-hour DOM/label rendering in each engine |
| Node resource interaction/placement ↔ browser resource keyboard/pointer scenarios | Policy/atomicity model versus real keyboard/pointer wiring and authoritative reprojection |
| Node CAS state model ↔ browser `storage.cas` | In-memory repository transition model versus real IndexedDB two-tab stale-write rejection |
| Node Multi-Month/Timeline range tests ↔ browser `custom.multi-month` / `custom.timeline` | Headless range/navigation math versus DOM composition, query count, action port and mutation |
| Node external-drop decoder contracts ↔ browser `drop.*` | Data validation versus real DOM drag/drop activation, authority and internal-drag separation |
| Browser `print.*` ↔ `visual.print` | Read-only/detached API semantics versus reviewed pixels |
| Browser `view.week` ↔ `visual.week` | Interactive/semantic layers and geometry alignment versus appearance |
| `storage.persist-reopen` ↔ `storage.reopen` | New repository instance persistence versus reopening the **same** instance after close |
| `storage.persist-reopen` ↔ `storage.crud` | Item persistence/raw-record revision versus source CRUD and fail-closed duplicate/unknown/removal rules |
| Resource Scheduler resize ↔ Resource TimeGrid resize | Separate UI implementations and geometry axes can regress independently |

**Browser-versus-Node conclusion:** no current browser scenario is a safe deletion merely because Node tests cover the underlying mathematics. The mathematical overlap is intentionally paired with a browser-only failure domain.

### Ranked removal / consolidation ledger for Pass F

No deletion is performed in Pass E. The following order is evidence-backed; every proposed removal has a surviving witness.

| Rank | Candidate | Trigger → invariant → failure mode | Pass-F action | Surviving witness after removal |
|---:|---|---|---|---|
| 1 | Exact Node/browser file and case counts in `coverage-audit.mjs` | Any refactor → numeric count unchanged → suite fails despite identical evidence | Delete count pinning | Test discovery itself + invariant/witness registry + scenario-registry uniqueness |
| 2 | Exact lane totals `147/53/42/9` | Tag/refactor → numeric total changed → false QA failure | Replace with set semantics: release contains every registered scenario; cross appears in all engines; visual is Chromium-only; smoke is the intended selected superset | Playwright `--list` membership/set comparisons, not totals |
| 3 | Exact screenshot count `9` | Add/remove reviewed baseline → count changes | Delete count assertion; retain orphan/missing-reference checks | Every committed baseline referenced + every declared visual baseline exists |
| 4 | `guards` exact `package.files` array and target-prefix/string-shape assertions | Package metadata refactor → strings differ despite same archive | Remove duplicate shape assertions; retain explicit public subpath/root boundary | `package-audit verify` actual archive + export target existence + parity |
| 5 | `package-audit` exact `tsconfig.package.exclude` array | Compiler-config refactor → literal globs differ despite identical production archive | Remove exact array equality | Full-build/package-build byte parity + no demo/fixture leakage + all exports present |
| 6 | Generic-contract literal availability export target | Package path refactor → one string changes | Remove literal path assertion | `guards` explicit `./features/availability` contract + package-manifest resolution |
| 7 | Historical negative API aliases | Old development name remains absent → no user-visible/architectural behaviour | Remove `DirectorCalendarEngine` / `DirectorCalendar` / `DIRECTOR_CALENDAR_CSS` absence checks; retain positive generic API use | Positive `CalendarEngine`/`CalendarUi`/`CALENDAR_CSS` imports throughout suite + generic dependency graph |
| 8 | Storage persistence/lifecycle setup repetition | Multiple tests rebuild near-identical IndexedDB setup → maintenance cost | Consolidate helpers/fixtures only; do **not** delete same-instance reopen, persistence or source-CRUD invariants | `persist-reopen`, `reopen`, `crud` remain separate behavioural witnesses |
| 9 | Oversized custom-view and external-drop browser bodies | Large inline harness setup → refactor-fragile tests and high maintenance | Extract bounded fixture/build helpers; keep expectations in scenario bodies | Same scenario IDs and assertions remain |
| 10 | Cross-engine execution of engine-neutral release scenarios | Same scenario × 3 engines → runtime duplication with little independent evidence | Defer to Pass H/I: retain scenario, reduce non-Chromium repetition only after choosing representative engine-sensitive witnesses | Chromium scenario + targeted Firefox/WebKit witnesses for DST, pointer, storage/concurrency, print/layout where engine variance matters |

### Node execution-cost profile

These are **full-lane** per-case-duration sums from CI run 43575578899. Four deep tests account for most of the difference between the 2.0 s fast runner and 6.2 s full runner.

| Node module | Cases | Sum of case durations | Slowest case |
|---|---:|---:|---|
| `architecture/guards` | 7 | 937.4 ms | module graph: 919.9 ms |
| `engine/core` | 27 | 155.3 ms | recurrence/DST/series edit: 29.3 ms |
| `engine/occurrence-authority` | 18 | 12.8 ms | baseline authority: 2.5 ms |
| `host/adapter-contracts` | 4 | 42.1 ms | overdue presentation: 32.8 ms |
| `host/generic-contracts` | 19 | 115.0 ms | read-only host snapshot: 36.9 ms |
| `host/integration` | 4 | 121.2 ms | realistic Director fixtures: 71.6 ms |
| `interop/contracts` | 17 | 149.9 ms | concurrent Google sync: 45.4 ms |
| `projection/occurrences` | 14 | 52.3 ms | existing recurrence projection: 31.3 ms |
| `resources/availability` | 6 | 45.6 ms | recurring availability fan-out: 31.6 ms |
| `resources/integrity` | 5 | 187.2 ms | deep hierarchy: 91.7 ms |
| `resources/interaction` | 5 | 32.7 ms | civil/DST interaction math: 24.9 ms |
| `resources/layout` | 6 | 48.1 ms | deterministic horizontal geometry: 34.7 ms |
| `resources/placement` | 12 | 47.1 ms | temporal-before-resource guard composition: 25.0 ms |
| `resources/time-grid-layout` | 7 | 88.5 ms | deterministic day × resource columns: 34.6 ms |
| `temporal/mathematical-invariants` | 6 | **4,654.1 ms** | deep civil/snap algebra: **3,798.1 ms** |
| `temporal/point-layout` | 8 | 40.7 ms | point chronology: 20.3 ms |
| `temporal/secondary-time-zone` | 6 | 68.7 ms | spring-forward primary geometry: 38.8 ms |
| `temporal/week-numbering` | 3 | **1,365.6 ms** | 400-year ISO oracle: **1,361.7 ms** |
| `view/capabilities` | 12 | 68.7 ms | year/agenda ranges: 36.6 ms |
| `view/custom-view` | 3 | 4.1 ms | registry order/metadata: 2.0 ms |
| `view/external-drop` | 3 | 5.9 ms | template validation: 2.9 ms |
| `view/multi-month` | 4 | 68.3 ms | contiguous 2/3/6/12-month range: 51.2 ms |
| `view/navigation` | 4 | 24.7 ms | inclusive clamp: 17.4 ms |
| `view/structured-presentation` | 5 | 5.9 ms | structured merge: 2.9 ms |
| `view/timeline` | 6 | 40.5 ms | generic horizontal layout: 22.6 ms |

**Cost judgement:** the expensive Node cases are mostly the strongest mathematical evidence and are already correctly tiered out of routine fast QA. The 919.9 ms module-graph test is the only routine Node cost centre worth optimizing mechanically; removing mathematical oracles would be the wrong optimization.

### Browser scenario execution profile

Approximate elapsed milliseconds from the full one-worker 147-execution release run. A dash means the visual scenario is intentionally Chromium-only.

| Scenario | Chromium | Firefox | WebKit | Approx. total |
|---|---:|---:|---:|---:|
| `storage.focus-fallback` | 207 | 596 | **4,507** | **5,310** |
| `custom.host-view` | 897 | 1,764 | 1,700 | **4,361** |
| `custom.multi-month` | 711 | 850 | 1,002 | 2,563 |
| `interaction.timed-drag` | 580 | 1,125 | 827 | 2,532 |
| `drop.authorized` | 538 | 743 | 1,238 | 2,519 |
| `print.all-views` | 619 | 644 | 1,155 | 2,418 |
| `resource.grid.pointer` | 302 | 1,153 | 544 | 1,999 |
| `storage.google-lock` | 383 | 717 | 743 | 1,843 |
| `custom.timeline` | 416 | 685 | 669 | 1,770 |
| `resource.timeline.pointer` | 451 | 585 | 734 | 1,770 |
| `print.snapshot` | 345 | 477 | 794 | 1,616 |
| `resource.timeline.keyboard-reassign` | 148 | 1,042 | 425 | 1,615 |
| `view.week` | 284 | 639 | 621 | 1,544 |
| `presentation.actions` | 247 | 451 | 837 | 1,535 |
| `storage.reminder-claim` | 146 | 836 | 510 | 1,492 |
| `storage.broadcast` | 215 | 540 | 609 | 1,364 |
| `storage.cas` | 189 | 501 | 587 | 1,277 |
| `storage.interop-identity` | 119 | 705 | 411 | 1,235 |
| `host.overdue` | 246 | 392 | 551 | 1,189 |
| `resource.timeline.hierarchy` | 181 | 371 | 626 | 1,178 |
| `storage.reload-generation` | 103 | 751 | 323 | 1,177 |
| `refresh.midnight` | 216 | 364 | 573 | 1,153 |
| `view.dst-fallback` | 219 | 388 | 517 | 1,124 |
| `storage.single-flight` | 106 | 611 | 326 | 1,043 |
| `view.week-numbers` | 205 | 423 | 374 | 1,002 |
| `resource.grid.diagonal-move` | 172 | 356 | 469 | 997 |
| `drop.opt-in` | 174 | 362 | 432 | 968 |
| `resource.timeline.committed-refresh-failure` | 169 | 334 | 446 | 949 |
| `embed.isolation` | 197 | 303 | 442 | 942 |
| `resource.grid.resize` | 166 | 352 | 423 | 941 |
| `resource.timeline.auto-scroll` | 256 | 301 | 383 | 940 |
| `storage.schema-reject` | 138 | 400 | 396 | 934 |
| `resource.grid.vertical-keyboard` | 161 | 328 | 438 | 927 |
| `resource.grid.render` | 162 | 303 | 460 | 925 |
| `resource.timeline.stale-refresh-failure` | 148 | 305 | 435 | 888 |
| `refresh.coalesce` | 127 | 325 | 411 | 863 |
| `resource.timeline.resize` | 150 | 294 | 411 | 855 |
| `custom.dispose` | 165 | 287 | 400 | 852 |
| `refresh.failure-recovery` | 136 | 323 | 368 | 827 |
| `storage.persist-reopen` | 131 | 331 | 360 | 822 |
| `storage.crud` | 119 | 281 | 349 | 749 |
| `storage.reopen-race` | 116 | 294 | 336 | 746 |
| `storage.schema` | 117 | 284 | 339 | 740 |
| `storage.close-open` | 100 | 270 | 327 | 697 |
| `storage.reopen` | 117 | 254 | 326 | 697 |
| `storage.interop-invalid` | 110 | 243 | 331 | 684 |
| `visual.resource-grid` | 535 | — | — | 535 |
| `visual.print` | 414 | — | — | 414 |
| `visual.week` | 375 | — | — | 375 |
| `visual.multi-month` | 373 | — | — | 373 |
| `visual.dst-fallback` | 344 | — | — | 344 |
| `visual.month` | 342 | — | — | 342 |
| `visual.multi-month-narrow` | 333 | — | — | 333 |
| `visual.day-narrow` | 305 | — | — | 305 |
| `visual.timeline` | 294 | — | — | 294 |

The **4.5 s WebKit foreground-fallback interval** is an outlier and should be remeasured before redesigning that scenario. The broad structural cost remains clear regardless of runner noise: repeating engine-neutral scenarios in Firefox and WebKit costs substantially more than Chromium-only execution.

### Pass E reconciliation

1. **Invariant-level inventory completed:** evidence is classified by behavioural, mathematical, integration, security/authority, architecture, presentation and superficial roles.
2. **True duplicates isolated:** current genuine redundancy is concentrated in count/census assertions, package/config string-shape checks and historical-name probes. No high-value mathematical witness is ranked for deletion.
3. **Cross-layer overlap reconciled:** browser scenarios that touch Node mathematics retain a distinct browser/DOM/IndexedDB/pointer/accessibility failure mode; none is marked for mathematical-duplication deletion.
4. **Runtime profiled:** all 25 Node modules and all 55 browser scenarios have measured current-run cost evidence.
5. **Removal ledger is safe:** every proposed deletion names a surviving witness. Partial overlaps are explicitly marked consolidation-only.
6. **Scope respected:** production and executable QA remain untouched in Pass E. Pass F may now perform the mechanical cleanup against this ledger, assertion by assertion.


## Pass F — canonical test structure and assertion cleanup (2026-11-14)

**Implementation source:** `qa-pass-f`, based on `working@c4662f4bf2769acf24d71f4b614244007fdebbdc`. Production `src/` remains untouched. Pass F implements the Pass E removal/consolidation ledger rather than optimizing for a target test count.

### Browser test-body cleanup

The two largest rendering specs now keep **expectations and scenario narrative in the spec** while moving only setup mechanics, host fixtures and reusable browser operations into explicit support modules:

| Scenario owner | Before | After | Extracted setup |
|---|---:|---:|---|
| `rendering/custom-views.spec.mjs` | ~730 lines | **234 lines** | `support/custom-view-fixtures.mjs`: four named mount/lifecycle helpers |
| `rendering/external-drop.spec.mjs` | ~448 lines | **162 lines** | `support/external-drop-fixtures.mjs`: authorized-drop mount + default-off probe |

The support modules contain no assertions and expose no mini test framework. The scenarios still state the observable DOM, mutation, authority, range, responsive, disposal and default-off expectations directly. All six original scenario IDs remain unchanged.

### Node engine ownership

The former ~780-line `engine/core.test.mjs` is split by behaviour rather than chronology:

- `engine/semantics.test.mjs`: **16** semantic engine contracts — canonical values, recurrence/series behaviour, placement/background geometry, source/item policy, planning/personal boundaries, invalidation generation and occurrence identity.
- `engine/repository-mutations.test.mjs`: **11** repository/mutation contracts — snapshot ownership, guarded commit, independent CAS state model, delta undo/redo, history staging and observer/subscriber failure isolation.

The split preserves the original 27 engine cases. The stale-revision mutation witness now points to the mutation-owned suite.

### Assertion cleanup from the Pass E ledger

Removed only evidence already superseded by a stronger witness:

- the duplicate architecture test that pinned exact `package.files` and export-target string shape; real `npm pack --dry-run` manifest verification remains canonical;
- historical negative API-name probes for `DirectorCalendarEngine`, `DirectorCalendar` and `DIRECTOR_CALENDAR_CSS`; positive generic API contracts remain;
- the literal availability export-path assertion; explicit optional-subpath/root-boundary and real archive resolution remain;
- exact `tsconfig.package.exclude` array equality; full-build/package-build parity and archive leakage checks remain.

No mathematical, authority, IndexedDB, cross-tab, pointer/keyboard or accessibility witness was removed.

### Invariant/witness registry replaces numeric census

`tests/qa/witness-registry.mjs` now defines **15 required invariants** across architecture, temporal, state, authority, integration, persistence, interoperability, resources, presentation and visual risk classes.

`tests/qa/coverage-audit.mjs` now verifies semantic contracts instead of arbitrary totals:

1. every required invariant declares at least one executable Node, browser or QA-script witness;
2. every referenced witness exists in executable source;
3. every browser scenario ID is declared exactly once and the executable scenario set equals the scenario registry;
4. routine smoke and release browser discovery match their scenario-tag membership as sets, not counts;
5. the combined routine lane covers every routine-required risk class, and the release lane additionally covers visual evidence.

The invariant audit now runs on ordinary CI as well as release CI. Cross/visual helper lanes remain selectable but are no longer invoked merely to prove historical execution totals.

### Targeted verification during Pass F

Permanent QA selection was not widened. For verification only, two release-only refactored scenarios were temporarily tagged into Chromium smoke and the four mutation injections were temporarily enabled; both changes were reverted after evidence was collected.

- Routine CI on the refactored tree: **210 declarations = 206 pass + 4 deliberate deep skips**, ~**1.26 s** Node runner; package manifest **185 files / 31 export subpaths**; all **15 invariant-registry contracts** and required routine/release risk classes verified.
- Normal browser smoke passed before the temporary QA expansion.
- Targeted expanded browser smoke passed **55/55**, explicitly including custom-view disposal and default-off external-drop/print behaviour.
- Selective mutation verification detected **4/4** injected defects: half-open interval boundary, stale CAS guard, recurrence COUNT leak and prefer-local sync deletion error; compiled artifacts were restored and hash-checked.
- Temporary smoke tags and unconditional mutation execution were then removed; canonical routine selection and mutation opt-in policy are restored.

### Pass F reconciliation

- **Canonical structure:** large scenario bodies now emphasize behaviour; setup mechanics are named and centralized without hiding expectations.
- **Node readability:** general engine semantics and repository mutation/history evidence have distinct owners.
- **Evidence quality:** superficial numeric, historical-name and package-string checks are gone; stronger publication and behavioural witnesses survive.
- **No count fetish:** declaration/file totals may now change without failing QA when invariant coverage remains intact.
- **Routine protection:** semantic invariant/lane coverage is enforced on ordinary CI.
- **CLEER outcome:** less spec-body duplication and weaker assertion debt, with no production behaviour change and no loss of independent mathematical or browser failure domains.
