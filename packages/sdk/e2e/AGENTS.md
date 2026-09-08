# SDK end-to-end tests

Use [`README.md`](README.md) and the current package scripts as the source of truth.

- Evaluate end-to-end impact for public SDK API, schema, model-constant, streaming,
  cancellation, and lifecycle changes.
- Extend existing definitions and executors when possible. New behavior should cover
  success, failure, and relevant platform-specific paths without broad fixtures.
- Keep smoke coverage small and deterministic. Put platform implementation in the
  matching executor rather than branching inside shared test definitions.
- For SDK API surface, model-constant, or inference changes, run
  `npm run install:build:full` from this package before focused tests; it rebuilds
  inference, SDK, and e2e as CI does. Use `npm run install:build` only for e2e-only
  changes. Rebuild mobile applications only when the README's dependency boundary
  requires it.
- Report any platform test that cannot run locally and the exact missing capability.
