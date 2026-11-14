export const requiredRiskClasses = Object.freeze({
  routine: Object.freeze([
    "architecture",
    "temporal",
    "state",
    "authority",
    "integration",
    "persistence",
    "interoperability",
    "resources",
    "presentation",
  ]),
  release: Object.freeze([
    "architecture",
    "temporal",
    "state",
    "authority",
    "integration",
    "persistence",
    "interoperability",
    "resources",
    "presentation",
    "visual",
  ]),
});

export const requiredInvariants = Object.freeze([
  {
    id: "architecture.generic-dependency-direction",
    risk: "architecture",
    witnesses: Object.freeze([
      { kind: "node", file: "tests/node/architecture/guards.test.mjs", title: "module graph enforces generic dependency direction" },
    ]),
  },
  {
    id: "architecture.public-package",
    risk: "architecture",
    witnesses: Object.freeze([
      { kind: "script", file: "tests/qa/package-audit.mjs", scriptToken: "package-audit.mjs verify" },
    ]),
  },
  {
    id: "temporal.half-open-collision-model",
    mutationRequired: true,
    risk: "temporal",
    witnesses: Object.freeze([
      { kind: "node", file: "tests/node/temporal/mathematical-invariants.test.mjs", title: "interval collision semantics match the half-open interval model exhaustively on a finite lattice" },
    ]),
  },
  {
    id: "temporal.independent-recurrence",
    mutationRequired: true,
    risk: "temporal",
    witnesses: Object.freeze([
      { kind: "node", file: "tests/node/temporal/mathematical-invariants.test.mjs", title: "UTC daily and weekly recurrence matches an independent civil-date enumeration across leap and year boundaries" },
      { kind: "node", file: "tests/node/temporal/mathematical-invariants.test.mjs", title: "recurrence follows independently known leap, month-end, and DST transition instants" },
    ]),
  },
  {
    id: "state.revision-guarded-atomicity",
    mutationRequired: true,
    risk: "state",
    witnesses: Object.freeze([
      { kind: "node", file: "tests/node/engine/repository-mutations.test.mjs", title: "revision-guarded repository transitions match an independent state model and never partially apply a stale proposal" },
    ]),
  },
  {
    id: "state.delta-undo-redo",
    mutationRequired: true,
    risk: "state",
    witnesses: Object.freeze([
      { kind: "node", file: "tests/node/engine/repository-mutations.test.mjs", title: "delta undo preserves unrelated later item changes and redo reapplies only the owned delta" },
    ]),
  },
  {
    id: "authority.fail-closed",
    mutationRequired: true,
    risk: "authority",
    witnesses: Object.freeze([
      { kind: "node", file: "tests/node/engine/occurrence-authority.test.mjs", title: "capability provider failure fails closed instead of crashing or falling back to writable authority" },
    ]),
  },
  {
    id: "integration.authoritative-occurrence-revalidation",
    mutationRequired: true,
    risk: "integration",
    witnesses: Object.freeze([
      { kind: "node", file: "tests/node/engine/occurrence-authority.test.mjs", title: "mutation coordinator executes occurrence commands with the latest authoritative occurrence payload and context" },
    ]),
  },
  {
    id: "integration.host-boundary",
    risk: "integration",
    witnesses: Object.freeze([
      { kind: "node", file: "tests/node/host/adapter-contracts.test.mjs", title: "Practice Desk working-shape scheduling evidence stays host-owned while Calendar receives only due-card projection" },
      { kind: "browser", id: "custom.host-view" },
    ]),
  },
  {
    id: "persistence.canonical-indexeddb",
    risk: "persistence",
    witnesses: Object.freeze([
      { kind: "browser", id: "storage.schema" },
      { kind: "browser", id: "storage.records" },
    ]),
  },
  {
    id: "persistence.cross-tab-convergence",
    risk: "persistence",
    witnesses: Object.freeze([
      { kind: "browser", id: "storage.cas" },
      { kind: "browser", id: "storage.broadcast" },
    ]),
  },
  {
    id: "interoperability.retry-and-conflict",
    mutationRequired: true,
    risk: "interoperability",
    witnesses: Object.freeze([
      { kind: "node", file: "tests/node/interop/contracts.test.mjs", title: "Google publish retry adopts its deterministic remote event after state-write failure" },
      { kind: "node", file: "tests/node/interop/contracts.test.mjs", title: "sync decision model covers every local/remote deletion-change state and conflict policy" },
    ]),
  },
  {
    id: "resources.atomic-placement",
    mutationRequired: true,
    risk: "resources",
    witnesses: Object.freeze([
      { kind: "node", file: "tests/node/resources/placement.test.mjs", title: "execution commits exactly once with canonical full assignments and never splits diagonal mutation" },
      { kind: "browser", id: "resource.grid.keyboard" },
    ]),
  },
  {
    id: "resources.pointer-keyboard-wiring",
    risk: "resources",
    witnesses: Object.freeze([
      { kind: "browser", id: "resource.timeline.keyboard" },
      { kind: "browser", id: "resource.timeline.pointer" },
      { kind: "browser", id: "resource.grid.keyboard" },
      { kind: "browser", id: "resource.grid.pointer" },
    ]),
  },
  {
    id: "presentation.accessible-actions",
    risk: "presentation",
    witnesses: Object.freeze([
      { kind: "browser", id: "presentation.actions" },
      { kind: "browser", id: "view.week-numbers" },
    ]),
  },
  {
    id: "presentation.browser-dst",
    risk: "presentation",
    witnesses: Object.freeze([
      { kind: "browser", id: "view.dst-fallback" },
    ]),
  },
  {
    id: "visual.reviewed-baselines",
    risk: "visual",
    witnesses: Object.freeze([
      { kind: "browser", id: "visual.week" },
      { kind: "browser", id: "visual.resource-grid" },
    ]),
  },
  {
    id: "state.seeded-reference-machine",
    mutationRequired: true,
    risk: "state",
    witnesses: Object.freeze([
      { kind: "node", file: "tests/node/engine/state-machine.test.mjs", title: "seeded calendar state machine agrees with an independent reference model across mutation history and refresh" },
    ]),
  },
  {
    id: "state.staged-multi-record-rollback",
    mutationRequired: true,
    risk: "state",
    witnesses: Object.freeze([
      { kind: "node", file: "tests/node/engine/state-machine.test.mjs", title: "multi-record recurrence split rolls back completely when staged tail creation fails" },
    ]),
  },
  {
    id: "temporal.monthly-yearly-reference-oracle",
    mutationRequired: true,
    risk: "temporal",
    witnesses: Object.freeze([
      { kind: "node", file: "tests/node/temporal/mathematical-invariants.test.mjs", title: "monthly and yearly recurrence match an independent bounded UTC oracle including filters limits exceptions and partitions" },
    ]),
  },
  {
    id: "resources.seeded-layout-invariants",
    risk: "resources",
    witnesses: Object.freeze([
      { kind: "node", file: "tests/node/resources/generated-invariants.test.mjs", title: "seeded resource layouts are permutation-independent bounded and collision-safe" },
    ]),
  },
  {
    id: "resources.atomic-host-state",
    risk: "resources",
    witnesses: Object.freeze([
      { kind: "node", file: "tests/node/resources/generated-invariants.test.mjs", title: "seeded resource placement outcomes preserve atomic host state on warning prevention and stale rejection" },
    ]),
  },
]);
