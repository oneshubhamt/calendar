# Contributing

Use the repository-pinned Node.js and npm versions before changing the calendar:

```sh
nvm use
npm ci
npm run check:fast
```

`check:fast` builds once, runs 207 routine Node cases, records four exhaustive/stress witnesses as intentionally skipped, and verifies the publication manifest after pruning only excluded development outputs. `npm run check` (alias `check:full`) executes all 211 Node cases, invokes the genuine `prepack` compiler, and verifies byte-for-byte parity of published output. The fast lane still retains the cheap independent recurrence/DST reference cases; only the genuinely costly exhaustive witnesses move to full QA.

For native browsers, use `qa:browser:smoke` (53 tagged Chromium/Firefox/WebKit executions) or `qa:browser` (147 full release executions). Combined `qa:fast` and `qa:full` share the first build between Node and browser tests. `qa:coverage` checks lane discovery and test inventory; `qa:mutation` injects four isolated compiled-output faults and requires their named tests to fail, restoring artifacts afterward.

CI runs fast Node/package checks plus the 53-execution browser smoke lane on ordinary non-`main` pushes and PRs. PRs targeting `main` and `main` pushes receive full publication verification plus the 147-execution browser release matrix. Weekly scheduled runs exercise the same full Node/package and browser-release gates; manual dispatch covers major-refactor/full and fault-injection checks.

Keep the core calendar domain-generic. Application-specific semantics belong behind adapters, integrations, or optional feature modules.
