# Calendar QA — canonical contract

This document is the durable human-readable QA contract for `@director/calendar`.
Executable truth lives in the test suites and the registries under `tests/qa/`; this file intentionally does **not** pin arbitrary file, case, screenshot or execution counts.

## Quality model

Calendar QA follows this evidence hierarchy:

1. independent reference model;
2. algebraic or metamorphic property;
3. behavioural/authority decision table;
4. representative boundary example;
5. browser-native integration journey;
6. source/shape assertion only where the shape itself is a public or architecture contract.

A test survives because it owns a distinct invariant or failure mode, not because of historical naming or census totals.

### Layer ownership

- **Node** owns deterministic mathematics, recurrence/reference models, state transitions, CAS, authority/policy, resource placement mathematics, architecture and package contracts.
- **Browser** owns failures that require a browser: IndexedDB implementations, multi-tab behavior, DOM accessibility, pointer/keyboard wiring, actual geometry/layout integration, print media and reviewed visual behavior.
- **Package audit** owns the real publication/archive contract rather than duplicate string-shape checks.
- **Mutation QA** validates the sensitivity of selected high-value independent witnesses. It remains deliberately hand-selected rather than becoming a general mutation-testing framework.

## Required risk classes

Routine QA must cover:

- architecture
- temporal
- state
- authority
- integration
- persistence
- interoperability
- resources
- presentation

Release QA additionally requires reviewed visual evidence.

The executable lists are `requiredRiskClasses` and `requiredInvariants` in
`tests/qa/witness-registry.mjs`.

## Required invariants

| Risk | Required invariant |
|---|---|
| Architecture | `architecture.generic-dependency-direction` |
| Architecture | `architecture.public-package` |
| Temporal | `temporal.half-open-collision-model` |
| Temporal | `temporal.independent-recurrence` |
| Temporal | `temporal.monthly-yearly-reference-oracle` |
| State | `state.revision-guarded-atomicity` |
| State | `state.delta-undo-redo` |
| State | `state.seeded-reference-machine` |
| State | `state.staged-multi-record-rollback` |
| Authority | `authority.fail-closed` |
| Integration | `integration.authoritative-occurrence-revalidation` |
| Integration | `integration.host-boundary` |
| Persistence | `persistence.canonical-indexeddb` |
| Persistence | `persistence.cross-tab-convergence` |
| Interoperability | `interoperability.retry-and-conflict` |
| Resources | `resources.atomic-placement` |
| Resources | `resources.pointer-keyboard-wiring` |
| Resources | `resources.seeded-layout-invariants` |
| Resources | `resources.atomic-host-state` |
| Presentation | `presentation.accessible-actions` |
| Presentation | `presentation.browser-dst` |
| Visual | `visual.reviewed-baselines` |

The registry owns exact witness paths/titles. `coverage-audit.mjs` verifies that every registered witness exists and that every browser scenario ID is declared exactly once.

## Mathematical and state evidence

High-value independent evidence that must not be replaced by a larger set of shallow examples includes:

- exhaustive finite-lattice half-open interval collision semantics;
- the 400-year ISO week oracle;
- bounded independent recurrence models for daily/weekly and monthly/yearly behavior;
- leap-year, month-end, timezone and DST known-instant checks;
- recurrence partition, identity/ordinal and exception behavior;
- deterministic seeded Calendar state-machine sequences through create/move/resize/recurrence/split/undo/redo/stale CAS/refresh;
- staged multi-record rollback;
- deterministic seeded resource layout/permutation/non-overlap/bounded-coordinate checks;
- resource placement atomicity across success, warning, prevention and stale rejection;
- independent revision/CAS and sync conflict models.

Pass G's state-machine evidence found a real split-series defect: a `this-and-following` tail was projected relative to the original series anchor rather than the split occurrence. Production now projects from the split anchor, and a permanent mutation witness guards against regression.

## Browser scenario policy

`tests/browser/scenario-registry.mjs` is the single source of truth for browser scenario tags.

A browser scenario should exist because its primary failure domain needs a browser. Pure recurrence/collision arithmetic, authority tables and repository state mathematics belong in Node even if a browser path also exercises them incidentally.

Closely related browser behaviors should share a coherent journey when one setup can prove several outcomes without obscuring which assertion failed.

### Routine lane

Routine smoke provides broad Chromium behavior plus a small all-engine subset.

Current measured selection:

- **18 Chromium scenarios**
- **8 of those engine-sensitive scenarios repeated in Firefox**
- **the same 8 repeated in WebKit**
- **34 browser executions total**

The current all-engine witnesses are:

- `interaction.timed-drag`
- `view.dst-fallback`
- `drop.authorized`
- `print.snapshot`
- `resource.timeline.pointer`
- `storage.schema`
- `storage.cas`
- `storage.focus-fallback`

These counts are measurements, not contractual constants. Set membership is derived from scenario tags.

### Exhaustive release lane

High-confidence browser QA runs:

- every registered scenario in Chromium;
- every nonvisual registered scenario in Firefox;
- every nonvisual registered scenario in WebKit;
- reviewed visual baselines in Chromium only.

The current compressed suite has 46 registered scenarios, giving **120 exhaustive executions**.
The historical 147-execution matrix belonged to the pre-compression 55-scenario suite; restoring 147 would duplicate evidence or resurrect superseded micro-scenarios.

### CI routing

`.github/workflows/browser-smoke.yml` is the sole browser workflow.

- ordinary feature-branch pushes/PRs → routine smoke;
- `main` pushes → exhaustive browser QA;
- PRs targeting `main` → exhaustive browser QA;
- version tags → exhaustive browser QA;
- weekly schedule → exhaustive browser QA;
- manual dispatch with `full=true` → exhaustive browser QA.

There is no second release workflow.

`coverage-audit.mjs` verifies per-project membership semantically:

- routine Chromium = `@smoke ∪ @cross`;
- routine Firefox/WebKit = `@cross`;
- release Chromium = all registered scenarios;
- release Firefox/WebKit = all registered nonvisual scenarios.

## Mutation evidence

`tests/qa/mutation-cases.mjs` is the canonical mutation registry.
`mutation-check.mjs` only executes each mutation in isolation and restores the compiled artifact.

Every mutation must:

1. have a stable ID and realistic defect description;
2. target exactly one canonical compiled-code location;
3. name at least one required invariant;
4. fail a focused Node test that is itself registered as a witness for every named invariant;
5. restore the original compiled bytes, verified by SHA-256.

Mutation-critical invariants are explicitly marked `mutationRequired: true`.
`coverage-audit.mjs` fails if one lacks a mutation or if a mutation is merely labelled with an invariant whose registered witness it does not actually exercise.

Current hand-selected fault families:

| Fault | Mutation-critical invariant |
|---|---|
| half-open boundary becomes closed | `temporal.half-open-collision-model` |
| stale repository revision overwrites state | `state.revision-guarded-atomicity` |
| recurrence COUNT leaks an occurrence | `temporal.independent-recurrence` |
| split tail reuses original series anchor | `state.seeded-reference-machine` |
| negative BYMONTHDAY shifts early | `temporal.monthly-yearly-reference-oracle` |
| prefer-local deletion applies remote | `interoperability.retry-and-conflict` |
| cancelled recurrence exception is emitted | `temporal.monthly-yearly-reference-oracle` |
| provider failure falls back to writable authority | `authority.fail-closed` |
| stale rendered occurrence bypasses authoritative revalidation | `integration.authoritative-occurrence-revalidation` |
| diagonal resource change becomes multiple host commits | `resources.atomic-placement` |
| undo ignores concurrent ownership change | `state.delta-undo-redo` |
| recurring split publishes head without tail | `state.staged-multi-record-rollback` |

Architecture/package, IndexedDB, accessibility, print and visual contracts are not forced into artificial source mutations when their appropriate oracle is package inspection or a real browser.

## Publication and architecture evidence

`tests/qa/package-audit.mjs` owns the publication contract:

- package build extends the strict main TypeScript configuration;
- package and normal build outputs retain byte parity where required;
- dry-run npm publication contains the expected exported artifacts and no forbidden QA/source leakage;
- every public export resolves inside the archive.

Architecture tests use the parsed source import graph for genuine dependency-direction and optional-feature-island contracts rather than broad source-regex assertions.

## Maintenance rules

When changing QA:

1. identify the invariant and cheapest trustworthy layer first;
2. do not delete a witness until an equal-or-stronger surviving witness is identified;
3. do not add exact file/case/execution totals as correctness contracts;
4. avoid browser replay of deterministic Node mathematics;
5. keep browser expectations visible even when setup is extracted;
6. prefer deterministic seeds and independent models over many hand-written variants;
7. keep mutation cases small, realistic and mapped to independent witnesses;
8. keep `witness-registry.mjs`, `scenario-registry.mjs` and `mutation-cases.mjs` as the only semantic registries for their respective domains;
9. profile the expensive browser layer before removing cheap mathematical Node evidence;
10. after substantial QA changes, run full Node/package, mutation, routine browser and exhaustive browser validation.

## Commands

- `npm run check:fast` — routine Node/build/package verification.
- `npm run check:full` — full/deep Node plus native package/parity verification.
- `npm run qa:coverage` — invariant, witness, browser-lane and mutation-contract audit.
- `npm run qa:mutation` — hand-selected mutation sensitivity.
- `npm run qa:browser:smoke` — routine browser lane.
- `npm run qa:browser:cross` — explicit all-engine subset.
- `npm run qa:browser:visual` — Chromium reviewed visuals.
- `npm run qa:browser` — exhaustive release browser lane.
- `npm run qa:full` — full Node + exhaustive browser + package/parity.

## Programme closure evidence

The original refinement audit found a suite with strong mathematical ideas but substantial census/shape testing, oversized browser setup and expensive browser execution. The original measured topology included 211 Node cases in 25 modules, 55 browser scenarios, 53 routine browser executions and 147 release executions.

Passes E–J changed the quality of evidence rather than chasing a smaller displayed test count:

| Measure | Original audited state | Closure state |
|---|---:|---:|
| Node cases | 211 | 215 |
| Browser scenarios | 55 | 46 |
| Routine browser executions | 53 | 34 |
| Exhaustive browser executions | 147 | 120 |
| Required semantic invariants | count/census-driven | 22 |
| Hand-selected mutations | 4 at initial audit / 6 before Pass J | 12 |
| Mutation detection | 4/4 initially / 6/6 before Pass J | 12/12 |

Key qualitative outcomes:

- exact test/file/scenario census assertions were removed;
- duplicate package-shape and historical-name assertions were removed where stronger evidence exists;
- large browser setup was extracted into named support fixtures without hiding assertions;
- Node engine tests were split into coherent semantic/mutation ownership;
- independent recurrence/state/resource models were strengthened;
- browser evidence was compressed to browser-native failure domains;
- routine cross-engine execution was narrowed while exhaustive all-engine release evidence was retained;
- mutation sensitivity became machine-linked to the invariant witness it claims to validate;
- the superseded duplicate browser release workflow was removed;
- this document was consolidated from the chronological pass diary into the current durable contract.

### Latest closure verification

A de novo source-level closure audit after Pass J found and corrected three remaining QA-programme gaps:

- the superseded `.github/workflows/browser-release.yml` still duplicated the exhaustive matrix already owned by `browser-smoke.yml`;
- mutation coverage verified only that an invariant ID was named, not that the mutation's failing test was actually a registered witness for that invariant;
- this document had grown into a 91 KB chronological diary containing obsolete census material rather than a lean canonical contract.

After those corrections, temporary full-verification gates passed:

- **215/215** full/deep Node tests, zero skips;
- package/parity audit with **185 files / 31 exported subpaths**;
- all **22 required invariants** and required routine/release risk classes;
- **12/12** mutation faults detected with artifact restoration;
- **120/120** exhaustive browser executions in **59.2 s**.

After restoring the normal workflow conditions, the repaired exact-head branch passed routine CI (**211 pass + 4 deliberate deep skips**, package manifest **185 files / 31 exported subpaths**, semantic coverage audit green) and routine browser QA (**34/34 in 24.2 s**).

Numbers in this section are dated evidence, not future pass/fail thresholds. The registries and semantic audits define the enduring contract.
