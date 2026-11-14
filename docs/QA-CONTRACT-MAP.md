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
