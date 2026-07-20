# `@qvac/fabric` integration tests

These tests run **real inference** through the two migrated consumers
(`@qvac/llm-llamacpp` and `@qvac/embed-llamacpp`) in a single Bare process to
prove that the shared `qvac__fabric.bare` runtime resolves, loads once, and
serves both addons.

## What is covered

- `llm-llamacpp runs inference through @qvac/fabric` — loads a small instruct
  model and generates a completion.
- `embed-llamacpp runs inference through @qvac/fabric` — loads an embedding
  model and produces an embedding of the expected dimension.
- `llm + embed share a single @qvac/fabric runtime in one process` — runs both
  consumers and (on Linux) asserts via `/proc/self/maps` that exactly one
  `qvac__fabric.bare` is memory-mapped. `dlopen` dedups by `SONAME`
  (`qvac__fabric@0.bare`), so a correctly shared runtime appears once even
  though two addons declared the dependency.

Test models are downloaded on first run into `model/` (git-ignored). They are
public GGUF files on Hugging Face and need no token.

## Filesystem-based package resolution

This harness has its own `package.json` that resolves all three workspace
packages directly from disk via the npm [`file:` protocol][file-deps]:

```json
{
  "dependencies": {
    "@qvac/fabric": "file:../..",
    "@qvac/llm-llamacpp": "file:../../../llm-llamacpp",
    "@qvac/embed-llamacpp": "file:../../../embed-llamacpp"
  }
}
```

`npm install` symlinks each `file:` dependency into `node_modules/`. The key
detail is that `@qvac/fabric` is pinned to the local checkout (version `0.1.0`),
which **satisfies the `^0.1.0` range that both consumers declare**, so npm
dedups all three to the same on-disk `@qvac/fabric`. That guarantees both
addons link the same runtime — which is exactly what the shared-runtime test
asserts.

The consumers' own transitive dependencies (`@qvac/infer-base`, `@qvac/logging`,
`bare-*`) are still resolved normally. On CI (where the private `@qvac` registry
token is configured) `npm install` pulls them automatically.

## Running

From the package root (`packages/fabric`):

```bash
npm run test:integration
```

Or directly in this directory:

```bash
npm install      # links the three local packages + helpers
npm test         # bare shared-runtime.test.js
```

[file-deps]: https://docs.npmjs.com/cli/v10/configuring-npm/package-json#local-paths
