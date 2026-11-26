# Changelog

## [0.12.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.12.0

`@qvac/rag` 0.12.0 makes the package safer to embed in a host app. The vector index survives hosts that lock module loading, a fallback to the slower scan and a failed snapshot are now visible, Node hosts can plug in their own index, and namespaces can store vectors at half the size. Input and import checks are stricter, and closing in the wrong order no longer hangs. Data written by 0.11.0 opens without migration.

## Breaking Changes

### TurboVec 0.8

The optional `@qvac/turbovec-ggml` peer range moves from `^0.4.0 || ^0.5.0` to `^0.8.0`. Hosts that install the addon need version 0.8: the index now uses TurboVec's asynchronous API, and older synchronous releases make search fall back to the scan.

### Stricter Input

Input that 0.11.0 accepted now fails with `INVALID_INPUT` before anything is written: strings that aren't well-formed UTF-16 (for example half an emoji left by cutting a string), stored rows over 8 MiB, a `__proto__` key in `metadata`, a `signal` that isn't an `AbortSignal`, and generations above 2^32. A cut string used to be stored as U+FFFD, which broke its export, and two names that differed only in such characters became the same name.

```typescript
// 0.12.0: repair text cut mid-character before ingesting
await rag.ingest({ namespace, documents: [{ id: 'a', text: text.toWellFormed() }] })
```

### Exports and 0.11.0

An `f16` namespace exports a new format version that 0.11.0 can't read, and 0.11.0 also refuses an export that contains a document without chunks. All other exports from this version import into 0.11.0, and 0.11.0 exports import here.

## New APIs

### Index Status and Fallback Events

If the TurboVec index can't load or fails, search falls back to an exact scan of the database: same results, much slower. That fallback used to be silent. `indexStatus` now reports how a namespace is searched and why, and `onIndexFallback` is called when a namespace switches to the scan. `ready()` also loads the addon and `bare-fs` up front, so a host that blocks module loading after startup keeps its index.

```typescript
const rag = createRag({
  corestore,
  index: { dir: './rag-index' },
  onIndexFallback: ({ namespace, reason }) => log.warn('rag scanning', namespace, reason)
})
await rag.ready()

await rag.indexStatus({ namespace: 'docs' })
// → { mode: 'index', revision: 42, snapshot: 'ok' }
// → { mode: 'scan', reason: 'addon-missing' } on Node without a provider
```

### Bring Your Own Index

TurboVec's binding only loads under Bare, so on Node every search used to scan. `index.provider` lets a host supply the index implementation. Snapshots use `bare-fs` on Bare and `fs` on Node, and `index.fs` can replace either. A provider without filtered search still works: scoped searches fetch extra candidates and filter them.

```typescript
const rag = createRag({
  corestore,
  index: { dir: './rag-index', provider: { create: (dim, storage) => myIndex(dim, storage) } }
})
```

### Snapshot Error Events

A snapshot that can't be read or written used to fail silently, so every reopen rebuilt the index from the database. `onSnapshotError` is now called with the namespace and the error. Searches keep using the index, and `indexStatus` reports the same error.

```typescript
const rag = createRag({
  corestore,
  index: { dir: './rag-index' },
  onSnapshotError: ({ namespace, error }) => log.warn('rag snapshot', namespace, error)
})
```

### Float16 Vector Storage

`createNamespace` takes `vectorEncoding: 'f16'` to store vectors at 2 bytes per component instead of 4. For 10,400 chunks of 768 dimensions the store shrinks from 49.3 MB to 33.0 MB. Scores move by a few millionths and recall@10 against `f32` stays at 0.9975 or above. The default stays `f32`, and exports keep the namespace's encoding.

```typescript
await rag.createNamespace({ name: 'docs', space, vectorEncoding: 'f16' })
```

### Documents Without Chunks

A document can now have no chunks, for example a scanned PDF with no text that a host wants to record so it isn't fed again. It is listed and exported with a `chunkCount` of 0 and never returned by search. Text that is empty or only whitespace becomes such a document instead of failing.

```typescript
await rag.ingest({ namespace: 'docs', documents: [{ id: 'scan.pdf', chunks: [] }] })
```

## Bug Fixes

Closing the host's Corestore before the RAG used to leave a database lock held, so later writes and `close()` never returned. Writes now fail with `DB_OPERATION_FAILED` and `close()` always resolves. Leftover index snapshot files, from failed writes or a process killed mid-write, are now cleaned up.

Imports verify each document's and delete record's ID and generation, so a damaged export can no longer rename or delete the wrong document. A failed or cancelled import no longer leaves an empty namespace behind, a namespace emptied by deletes accepts imports again, and an ingest running during an import no longer fails with a false "dropped" error. A `source` that throws now fails with the new `IMPORT_SOURCE_FAILED` code.

The package builds without the `bare` CLI.

## [0.11.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.11.0

`@qvac/rag` 0.11.0 adds what an app needs around search: reading documents back, listing them, moving whole namespaces between stores, and keeping one long document from crowding out the rest of a result. Search hits now carry citation details. Data written by 0.10.0 opens without migration.

## Search Across Documents, With Citations

`perDocument` spreads the `k` hits across documents: every document's best hit is taken before any document gets a second one, and no document gets more than `perDocument`. When `scope.documentIds` lists at most `k` documents, each listed document that has chunks gets a hit. `minScore` drops weak hits first, so a result can hold fewer than `k`.

```typescript
const hits = await rag.search({
  scope: { namespace: 'handbook' },
  query,
  k: 8,
  perDocument: 2,
  minScore: 0.4
})
// hits[0] → { documentId: 'manual', ordinal: 12, generation: 3, chunkCount: 40,
//             citation: { title: 'Manual', page: 7 }, score: 0.82, ... }
```

Every hit now reports its document's `generation`, how many chunks that generation has, and a `citation` with `title`, `page`, `sourceUrl`, `sourcePath` and `mimeType` where the document metadata or the chunk's `rag-extract` metadata holds them.

## Read and List Documents

`readDocument` returns a document's chunks in order, a page at a time, so a hit can be expanded into its surrounding text. Passing the first page's `generation` on later pages makes the read fail with `DOCUMENT_CHANGED` if the document was re-ingested or deleted in between, instead of mixing two versions. `listDocuments` pages through a namespace in document ID order; each entry's `revision` gives ingest order.

```typescript
const page = await rag.readDocument({
  namespace: 'handbook',
  documentId: 'manual',
  fromOrdinal: 4,
  limit: 3
})
// → { generation: 3, chunkCount: 40, chunks: [{ chunkId, ordinal: 4, content }, ...], nextOrdinal: 7 }

const { documents, next } = await rag.listDocuments({ namespace: 'handbook', limit: 100 })
```

Scoped handles from `rag.scoped(scope)` gain both calls, limited to their scope. Deleting a document now keeps its last generation, so ingesting the same ID again continues the numbering instead of reusing it.

## Export, Import, List and Drop Namespaces

`exportNamespace` streams a namespace, or some of its documents, as bytes that `importNamespace` reads into another store, with no re-embedding. Imports keep generations and deletes, report what they skipped and why, and can be stopped with an `AbortSignal` or by closing the RAG. `listNamespaces` reports each namespace's space, index storage and counts, and `dropNamespace` deletes a namespace with its index snapshot.

```typescript
const backup = rag.exportNamespace({ namespace: 'handbook' }) // AsyncIterable<Uint8Array>
const result = await other.importNamespace({ namespace: 'handbook', source: backup })
// → { documents: [{ id, generation, status: 'created' }], skipped: [], cancelled: false, revision }

await rag.listNamespaces() // [{ name, spaceId, space, index, revision, documentCount, chunkCount }]
await rag.dropNamespace({ name: 'handbook' }) // { name, documentCount, chunkCount }
```

A namespace only imports into one from the same history: a malformed stream fails with `IMPORT_INVALID`, and a non-empty namespace with a different history fails with `IMPORT_LINEAGE_MISMATCH`.

## [0.10.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.10.0

`@qvac/rag` 0.10.0 is a rewrite. The package is now a small embedded store for document chunks and their embeddings, built on HyperDB, with search that only ever looks inside the scope you grant it. It can chunk and embed text through an embeddings port you supply, keeps an optional TurboVec index per namespace, and skips documents whose content has not changed. It runs on Bare and Node.

## Breaking Changes

The `RAG` class and its adapter system are replaced by a `createRag()` factory. Storage, chunking and LLM answer generation are no longer bundled together: `@qvac/rag` stores and searches, and you call your LLM with the hits yourself.

Before:

```typescript
import { RAG, HyperDBAdapter } from '@qvac/rag'

const rag = new RAG({ dbAdapter: new HyperDBAdapter({ store }), embeddingFunction })
await rag.ready()
await rag.saveEmbeddings([{ id: 'a', content, embedding, embeddingModelId: 'm' }])
const results = await rag.search(query)
```

After:

```typescript
import { createRag } from '@qvac/rag'

const rag = createRag({ corestore: store })
await rag.ready()
const { spaceId } = await rag.createNamespace({ name: 'docs', space })
await rag.ingest({
  namespace: 'docs',
  documents: [{ id: 'a', chunks: [{ content, embedding, spaceId }] }]
})
const hits = await rag.search({ scope: { namespace: 'docs' }, vector, spaceId, k: 5 })
```

Every namespace is pinned to one embedding space, identified by a `spaceId` hash of the model, dimensions, metric and encodings. Precomputed chunks and vector queries must carry that `spaceId`, so vectors from different models never mix. Search reads only the namespace and document IDs in its `scope`, and fails closed on a missing namespace, an unknown scope key or a document outside the namespace. `rag.scoped(scope)` returns a search handle that can narrow its scope but never widen it.

The following exports are removed: `RAG`, `HyperDBAdapter`, `TurboVecAdapter` and its types, `BaseDBAdapter`, `LLMChunkAdapter`, `BaseChunkAdapter`, `BaseLlmAdapter`, `HttpLlmAdapter`, `QvacLlmAdapter`, and the embedding and document zod schemas. `ERR_CODES` drops the codes those classes used (`LLM_REQUIRED`, `GENERATION_FAILED`, `CHUNKING_FAILED` and others); their numbers are not reused.

0.10.0 uses a new HyperDB schema and does not migrate data written by 0.9.x. Re-ingest your documents into a fresh Corestore.

## Text Ingest Through an Embeddings Port

Pass an embeddings port to `createRag()` and `ingest()` accepts plain text or pre-chunked text as well as precomputed vectors. Text is chunked with `rag-extract`, embedded in batches, and committed one document at a time. Ingest reports progress, can be cancelled with an `AbortSignal` without losing the documents already committed, and `search()` accepts a text `query`.

```typescript
const rag = createRag({ corestore, embeddings: port })
await rag.ready()
await rag.createNamespace({ name: 'handbook', space: port.space })

const { documents, skipped, cancelled } = await rag.ingest(
  { namespace: 'handbook', documents: [{ id: 'leave-policy', text }] },
  { signal, onProgress: ({ stage, done, total }) => {} }
)
const hits = await rag.search({ scope: { namespace: 'handbook' }, query: 'leave days', k: 5 })
```

## Indexed Search With TurboVec

On Bare, when the optional peer `@qvac/turbovec-ggml` is installed and loads, each namespace gets a TurboVec index derived from HyperDB, and candidates are rescored exactly against the stored vectors. Pass `index.dir` to keep snapshots between runs, and pick `q8` (default), `f32`, `turbovec-q4` or `turbovec-q2` storage per namespace. On Node, or without the peer, search falls back to an exact scan.

```typescript
const rag = createRag({ corestore, index: { dir: './rag-index', snapshotEvery: 256 } })
const { index } = await rag.createNamespace({
  name: 'docs',
  space,
  index: { storage: 'turbovec-q4' }
})
```

The README lists measured memory use: about 320 MiB to open a 100,000-chunk namespace from a snapshot, and about 1 GiB the first time it is built without one.

## Unchanged Documents Are Skipped on Re-ingest

Re-ingesting a document whose content has not changed writes nothing and does not call the embeddings port. Each ingested document now reports a `status` of `created`, `replaced` (with the number of chunks removed) or `unchanged`.

```typescript
const { documents } = await rag.ingest({ namespace: 'docs', documents: [{ id: 'a', text }] })
// [{ id: 'a', generation: 2, chunkCount: 3, status: 'replaced', removedChunks: 4 }]
```

## Bug Fixes

`@qvac/rag` can now be imported on Node.js as well as Bare.

## [0.9.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.9.0

TurboVec index providers can now initialize asynchronously, allowing them to dynamically import their native addon before creating or loading an index. Existing synchronous providers remain supported.

## Asynchronous TurboVec initialization

`TurboVecAdapter` waits for provider initialization during writes, index rebuilds, and checkpoint recovery. Queued mutations, fallback to another storage format, scan-based search, and cleanup during close continue to work with asynchronous providers.

## Await direct provider calls

`TurboVecIndexProvider.create()` and `load()` now return `TurboVecIndex | Promise<TurboVecIndex>`. If you call either method through the provider interface, await its result before using the index.

Before:

```typescript
const index = provider.create({ dim: 8, storage: 'q8' })
const restored = provider.load(snapshotPath)
index.dispose()
restored.dispose()
```

After:

```typescript
const index = await provider.create({ dim: 8, storage: 'q8' })
const restored = await provider.load(snapshotPath)
index.dispose()
restored.dispose()
```

Code that uses `TurboVecAdapter` without calling the provider directly needs no changes.

## [0.8.1]

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.8.1

This patch makes TurboVec-backed RAG usable on Windows. In 0.8.0 every attempt to open a TurboVec workspace failed there, and the package could not be built on Windows at all.

## Fixed

### TurboVec workspaces open and checkpoint on Windows

`TurboVecAdapter` forces its writer lock and its checkpoint files to disk before installing them, and Windows refuses that unless the file was opened for writing. Opening a workspace therefore always ended in `Failed to acquire the TurboVec writer lock`. Workspaces now open, checkpoints complete, and the journal records a checkpoint covers are pruned, so a Windows workspace no longer retains every mutation record. When the lock genuinely cannot be taken, the error names the underlying reason rather than only a generic code.

### `@qvac/rag` builds on Windows

Installing the package on Windows failed while running its build, because the build scripts derived their own directory from a file URL and produced a doubled drive letter (`C:\C:\...`). The integration test and the quickstart example resolved their fixture paths the same way.

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
