# Contributing

Use the repository-pinned Node.js and npm versions before changing the calendar:

```sh
nvm use
npm ci
npm run check
```

`npm run check` is the normal quality gate: strict TypeScript typechecking, the complete non-visual test suite, and package-content validation. Screenshot/browser-gallery testing is intentionally not part of routine QA.

Keep the core calendar domain-generic. Application-specific semantics belong behind adapters, integrations, or optional feature modules.
