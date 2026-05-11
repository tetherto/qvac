# QVAC RAG v0.5.0 Release Notes

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
