# Changelog

## [0.8.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.8.0

This release adds `TurboVecAdapter`, which uses an injected native vector index for candidate search while keeping HyperDB as the durable source of truth. It also strengthens HyperDB writes so invalid or partially failed batches cannot leave inconsistent document and vector records.

## TurboVec-backed search

`TurboVecAdapter` accepts a `TurboVecIndexProvider`, so applications can supply a compatible native index without making `@qvac/rag` depend directly on an embedding addon. The adapter uses the native index to find candidates, then reads and scores the matching records from HyperDB.

```typescript
import { TurboVecAdapter, type TurboVecIndexProvider } from '@qvac/rag'
import IdMapIndex from '@qvac/embed-llamacpp/idMapIndex'

const indexProvider: TurboVecIndexProvider = {
  create: (options) => new IdMapIndex(options),
  load: (snapshotPath) => IdMapIndex.load(snapshotPath)
}

const adapter = new TurboVecAdapter({
  store,
  dbName: 'workspace',
  indexProvider,
  checkpointDir: '/path/to/index'
})
```

## Recovery and writer safety

Mutation records and revisioned checkpoints let the adapter rebuild or refresh its native index from HyperDB after an interrupted write or stale checkpoint. A heartbeat-based writer lock prevents two adapter instances from changing the same index at the same time. If the native index is unavailable, HyperDB remains available as the authoritative data store.

## Consistent HyperDB writes

`HyperDBAdapter` now rejects batches that mix embedding dimensions with `EMBEDDING_DIMENSION_MISMATCH`. If a batch write fails partway through, it discards the transaction and retries complete document and vector pairs instead of committing partial rows. Search snapshots are also closed after each operation.

## [0.7.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.7.0

`@qvac/rag` is now TypeScript compiled to ESM. CommonJS `require('@qvac/rag')` no longer works — switch to `import`. Invalid `search` and `infer` queries throw `QvacErrorRAG` with `INVALID_INPUT` instead of a raw `TypeError`. Named exports are unchanged.

## Breaking Changes

### ESM only

The package is `"type": "module"`. Node rejects `require()` of ESM. Use `import`. Named exports (`RAG`, `HyperDBAdapter`, adapters, `ERR_CODES`, `QvacErrorRAG`) are the same. `@qvac/rag/errors` still exports the error class and codes without loading the full package.

**Before:**

```js
const { RAG, HyperDBAdapter } = require('@qvac/rag')
```

**After:**

```ts
import { RAG, HyperDBAdapter } from '@qvac/rag'
```

The 0.6.1 Pear/CJS `require()` path for hard dependencies is gone with this conversion. Pear consumers need an ESM-capable loader.

## Bug Fixes

### Query validated before logging

`rag.search()` and `rag.infer()` reject a non-string or blank query with `QvacErrorRAG { code: INVALID_INPUT }` before any debug log reads `query.substring`. Valid queries are unchanged. Previously a non-string hit `TypeError` at the log line and never reached the existing search guard.

## [0.6.4]

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.6.4

This patch drops the unused `crypto-browserify` hard dependency. The package never imported it.

## Changed

### Unused `crypto-browserify` dependency removed

`#crypto` still resolves to `bare-crypto` on Bare, `node:crypto` on Node, and `globalThis.crypto` on browser / React Native. Consumers that need Node-style `crypto.createHash` (for example HyperDB document hashing in a browser or React Native runtime) should install `crypto-browserify` themselves and assign it to `globalThis.crypto`, as documented in the README.

## [0.6.3]

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.6.3

This patch bumps the production `bare-fetch` dependency across the 2→3 major to `^3.0.1`.

---

## 🔧 Changed

### `bare-fetch` bumped to `^3.0.1`

The 2→3 transition is transitive-only — the public fetch API is unchanged. The only behavioral change in 3.x is the header validation added in 3.0.1, and RAG only constructs RFC-valid headers, so no code change is required. The bare-tls trust-store change already shipped within the 2.x line via `bun.lock`.

## [0.6.2]

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.6.2

This patch fixes a package exports gap that broke SDK consumer installs when TypeScript compiled `@qvac/rag/errors` imports to `@qvac/rag/errors.js`.

---

## 🔌 API

### `./errors.js` export alias

TypeScript ESM output appends `.js` to subpath imports. Node enforces `package.json#exports` strictly, so `@qvac/rag/errors.js` failed even though `@qvac/rag/errors` worked. This release adds a matching `./errors.js` export entry pointing at the same module as `./errors`.

No API surface change — existing `@qvac/rag/errors` imports continue to work unchanged.

## [0.6.1]

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.6.1

This patch restores Pear/CJS compatibility for RAG adapters and adds a lightweight `./errors` subpath so SDK consumers can import error codes without pulling in the full package entry.

---

## 🐞 Fixes

### Pear/CJS compatibility (#2284)

RAG adapters now load hard dependencies (`hyperdb`, `hyperschema`, `llm-splitter`, `#fetch`) via synchronous `require()` instead of dynamic `await import()`. This fixes `MODULE_NOT_FOUND` failures when running RAG under Pear, where ESM dynamic imports are unavailable in the CJS module graph.

---

## 🔌 API

### `@qvac/rag/errors` subpath (#2303)

Consumers can now import RAG error codes and the error class from a dedicated subpath that does not transitively load `HyperDBAdapter` or other heavy runtime deps:

```typescript
import { ERR_CODES, QvacErrorRAG } from '@qvac/rag/errors'

if (err instanceof QvacErrorRAG && err.code === ERR_CODES.OPERATION_CANCELLED) {
  // handle cancellation
}
```

Existing `import { ERR_CODES } from "@qvac/rag"` continues to work unchanged.

## [0.6.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.6.0

This release completes the HyperDB 6 migration for `@qvac/rag`, aligning with the published `@qvac/registry-schema@0.3.0` and `@qvac/registry-client@0.6.0` stack. RAG now owns the Holepunch libraries it imports at runtime as direct dependencies instead of optional peers. The public RAG API is unchanged.

---

## 🔧 Changed

### HyperDB 6 and regenerated specs (#2255)

`hyperdb` is bumped from the HyperDB 4 peer range to `^6.7.0` as a direct dependency. The autogenerated HyperDB spec under `src/adapters/database/hyperspec/` is rebuilt with the HyperDB 6 compiler output.

### Dependency graph cleanup

Runtime imports (`bare-crypto`, `bare-fetch`, `hyperdb`, `hyperdht`, `hyperschema`, `llm-splitter`) move from `peerDependencies` back to direct `dependencies` — matching the registry hyperdb v6 cascade and avoiding peer-range drift when installed alongside `@qvac/sdk`. The `@qvac/registry-client` dev dependency is bumped to `^0.6.0` for examples and integration tests.

## [0.5.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.5.0

This release makes `@qvac/rag` a first-class citizen in non-Bare runtimes — React Native and Expo bundlers no longer choke on Bare-specific imports — and tightens the package's place in the SDK install graph so Holepunch singletons (DHT, Corestore, HyperDB) are no longer duplicated in consumer trees. It also lands a small but real bug fix in RAG's crypto-fallback error path so consumers can finally catch missing-dependency errors by code.

---

## 🐞 Fixes

### React Native / Expo bundling: `LLMChunkAdapter` is exported again

Previously, importing `@qvac/rag` from a React Native or Expo project failed with `SyntaxError: 'LLMChunkAdapter' not exported` even though the export was present in the source — the bundler was getting corrupted output because RAG's source had hard `bare-crypto` and `bare-fetch` imports that non-Bare bundlers tried (and failed) to resolve.

Bare-specific dependencies are now routed through Node.js `package.json#imports` so the right module is selected per runtime:

- `#crypto` resolves to `bare-crypto` on Bare, `node:crypto` on Node, and a lazy shim on React Native and other targets.
- `#fetch` resolves to `bare-fetch` on Bare and a lazy shim on Node, React Native, and other targets.

The shims allow bundling to succeed and only throw `QvacErrorRAG { DEPENDENCY_REQUIRED }` if the missing capability is actually invoked at runtime. Consumers on browsers, React Native, or Node who need Node-style `crypto.createHash` (notably for HyperDB document hashing) can install `crypto-browserify`, which is now declared as an **optional peer dependency**.

`generateId()` no longer mutates a global `crypto` or depends on `uuid-random`. It generates UUID v4 IDs locally using secure randomness from `globalThis.crypto.getRandomValues` or `#crypto.randomBytes` / `getRandomValues`, and throws a clear error if neither is available.

### `QvacErrorRAG` in crypto fallbacks now reports the correct error code

Two RAG crypto-fallback call sites were constructing `QvacErrorRAG` with positional arguments `(code, message)` instead of the canonical `{ code, adds }` options object. Because `QvacErrorBase` destructures its single options argument, the thrown error silently degraded to code `0` / `"Unknown QVAC error"` instead of the intended `DEPENDENCY_REQUIRED` (14015) — so consumers catching by code never matched. Both call sites in `helper.js` and `HyperDBAdapter.js` now use the canonical form, and the documented error code is what's actually thrown.

---

## 🧹 Maintenance

### Holepunch singletons moved to `peerDependencies`

`@qvac/rag` previously declared `hyperdb`, `hyperdht`, `hyperschema`, `bare-crypto`, `bare-fetch`, and `llm-splitter` as hard dependencies. When the SDK declared its own (drifting) ranges for these as peers, npm could end up installing duplicate copies of stateful singletons in a consumer's tree — separate DHT nodes, separate Corestores, broken P2P connectivity. These libraries are now `peerDependencies` (mirrored in `devDependencies` so the package still builds and tests in isolation), and `@qvac/sdk` is the single source of truth for the actual installed range. `hyperdht` is marked optional in RAG since it is reserved for the not-yet-wired `replicateWith` path.

Consumers using `@qvac/sdk` or any tooling that auto-installs required peers (npm 7+, pnpm, bun) are unaffected — the peers resolve transparently. Direct standalone consumers of `@qvac/rag` using `yarn` or `legacy-peer-deps=true` may now see missing-peer warnings and should add `hyperdb`, `hyperschema`, and `bare-crypto` (and `bare-fetch` if used in a Bare runtime) to their own dependencies.

### DataLoader cleanup: examples and integration tests off `@qvac/dl-hyperdrive`

The RAG examples and integration test no longer depend on `@qvac/dl-hyperdrive`. Model fetching now goes through `@qvac/registry-client` (mirroring how the SDK and OCR addons consume the QVAC registry), and the addon construction has migrated from the old `HyperDriveDL` + loader-based shape to the current files-based shape (`{ files, config, logger, opts }`).

To support this, `devDependencies` were updated:

- Removed: `@qvac/dl-hyperdrive`
- Added: `@qvac/registry-client@^0.4.1`
- Bumped: `@qvac/embed-llamacpp` `^0.7.6 → ^0.14.0`, `@qvac/llm-llamacpp` `^0.5.7 → ^0.16.0` (versions that ship the files-based API).

This is purely a developer-facing change — runtime behavior of `@qvac/rag` is unchanged. The SDK-side `overrides: { @qvac/dl-hyperdrive: ^0.2.0 }` is intentionally retained until the addons-side cleanup of `@qvac/infer-base`'s `dl-hyperdrive` peer dep lands.

## [0.4.4]

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.4.4

This release focuses on dependency hygiene and package namespace consistency for the RAG library. It aligns documentation with the `@qvac` npm scope and updates core crypto dependency declarations to match current runtime expectations.

---

## 📘 Documentation

README references have been updated from the legacy `@tetherto` namespace to `@qvac`, reducing installation confusion and ensuring examples match currently published package names.

---

## 🧹 Maintenance

`bare-crypto` dependency declarations were updated to `^1.13.4`, and related `package.json` cleanup was applied in the RAG package. This keeps dependency metadata aligned with the current SDK pod ecosystem and reduces drift across package manifests.
