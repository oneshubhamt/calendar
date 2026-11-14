# Contributing

Use the repository-pinned Node.js and npm versions before changing the calendar:

```sh
nvm use
npm ci
npm run check:fast
```

`check:fast` builds once, runs every Node test and verifies the publication manifest after pruning only excluded development outputs. `npm run check` (alias `check:full`) also invokes the genuine `prepack` compiler and verifies byte-for-byte parity of published output. Both run all 211 Node cases.

For native browsers, use `qa:browser:smoke` (53 tagged Chromium/Firefox/WebKit executions) or `qa:browser` (147 full release executions). Combined `qa:fast` and `qa:full` share the first build between Node and browser tests. `qa:coverage` checks lane discovery and test inventory; `qa:mutation` injects four isolated compiled-output faults and requires their named tests to fail, restoring artifacts afterward.

CI runs fast checks on ordinary branches and full publication/browser verification for `main`. Manual CI dispatch can request full publication verification and/or fault injection.

Keep the core calendar domain-generic. Application-specific semantics belong behind adapters, integrations, or optional feature modules.
