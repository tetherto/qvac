# SDK end-to-end tests

Use [`README.md`](README.md) and the current package scripts as the source of truth.

- Evaluate end-to-end impact for public SDK API, schema, model-constant, streaming,
  cancellation, and lifecycle changes.
- Keep `catalog/` client-neutral: a client's own behavior belongs in its runner under
  `runners/`, and the catalog imports from neither a runner nor a client. A wire shape
  it needs goes in `catalog/wire-types.ts`, checked by `check:contract`.
- Extend existing definitions and executors when possible. New behavior should cover
  success, failure, and relevant platform-specific paths without broad fixtures.
- Keep smoke coverage small and deterministic. Put platform implementation in the
  matching executor rather than branching inside shared test definitions.
- For SDK API surface, model-constant, or inference changes, run
  `npm run install:build:full` from this package before focused tests; it rebuilds
  inference, SDK, and e2e as CI does. Use `npm run install:build` only for e2e-only
  changes. Rebuild mobile applications only when the README's dependency boundary
  requires it.
- Run `npm run format`, `npm run typecheck` and `npm run check:catalog` from this package
  before handoff; the SDK pod checks run `format` and `check:catalog` here.
- Report any platform test that cannot run locally and the exact missing capability.
