# @qvac/turbovec-ggml

`IdMapIndex` is a CPU vector index with stable unsigned 64-bit IDs.
It stores vectors as full `f32`, generic `q8`/`q4` quantized codes, or
TurboVec `q4`/`q2` codes searched directly in their quantized form.

The index runs on the vector-index API of the shared `@qvac/fabric` runtime,
which this addon links dynamically. It loads no ggml compute backends and
needs no model.

## Usage

```javascript
const IdMapIndex = require('@qvac/turbovec-ggml')

const index = new IdMapIndex({ dim: 768, storage: 'turbovec-q4' })
try {
  index.addWithIds(vectors, new BigUint64Array([1n, 2n]))
  index.prepare()
  const { ids, scores } = index.search(query, 2)
} finally {
  index.dispose()
}
```

The class is also exported as `IdMapIndex` (with `IdMapIndexFilter`), from the
package root and from the `@qvac/turbovec-ggml/idMapIndex` subpath, for both
CommonJS and ESM.

`vectors` contains row-major `Float32Array` data with one `dim`-sized row per ID. Queries use the same layout and may contain multiple rows. Search uses dot-product similarity; L2-normalize indexed vectors and queries first when cosine similarity is required. Results are ordered by descending score and then ascending ID. Short result rows are padded with the ID `UINT64_MAX`, which is reserved and cannot be added.

## Storage modes

| Storage | Effective bits | Snapshot | Mmap | Delta log |
|---------|---------------:|----------|------|-----------|
| `f32` | 32 | v2 | Yes | Yes |
| `q8` | 8 | v2 | Yes | Yes |
| `q4` | 4 | v2 | Yes | Yes |
| `turbovec-q4` | 4 | v8 | No | No |
| `turbovec-q2` | 2 | v8 | No | No |

The default storage is `q8`. `bitWidth: 2` selects `turbovec-q2`, while `bitWidth: 4` selects generic `q4`; use `storage: 'turbovec-q4'` explicitly for TurboVec Q4.

TurboVec requires a 64-bit target and dimensions divisible by 8 and no greater than 16,384. It is a port of upstream turbovec 1.1.2 and provides approximate rotated/quantized dot-product search. TurboVec snapshots use turbovec's v8 container and support `write()` and `load()`, but reject mmap loading, delta-log loading, logged mutations, and delta compaction. v3 snapshots written by earlier releases still load, keep their encoding and keep writing v3.

A fresh TurboVec index fits its TQ+ calibration from its first `addWithIds()` batch when that batch has at least 1,000 rows (from up to 4,096 rows spread across a larger batch, fewer above 4,096 dimensions so the sample stays within 64 MiB), which improves recall. A smaller first batch leaves the index uncalibrated; it still works, without that gain. An empty or rejected first batch does not count, so the next one can still calibrate. The `calibrated` getter reports the state, and a loaded index keeps the state it was saved with.

Staged search is off for every new or loaded TurboVec index, so a search scores every vector. `setStagedSearch(true)` turns on upstream's staged search: from 32,768 vectors it scans a compressed form first and scores only a shortlist, several times faster per query but with lower recall, most of all at small k. It applies only at a dimension divisible by 32, on hosts that support it, and never to an index loaded from a v3 snapshot; elsewhere the setting is kept but every search scans in full. The setting is not saved in snapshots, `stagedSearch` reports it, and other storages throw.

## Operations and lifecycle

- `addWithIds()`, `remove()`, `contains()`, and `compact()` mutate or inspect the index.
- `search()`, `searchFiltered()`, and `prepareFilter()` perform full-scan retrieval.
- `buildIvf()` enables approximate `searchIvf()` retrieval. IVF state is in-memory only and must be rebuilt after a mutation or snapshot load.
- `write()` and `load()` persist all storage modes. Generic `f32`, `q8`, and `q4` additionally support `loadMmap()`, `loadWithDelta()`, `addLogged()`, `removeLogged()`, and `compactDelta()`.
- Mutations invalidate prepared filters and IVF state.
- Call `dispose()` on indexes and prepared filters when finished. Disposal is idempotent.
- Every method above runs synchronously on the calling thread. The ones that
  can run long also have async variants that run off the JS thread: see
  [Async API](#async-api).

Errors thrown by the native index carry the fabric error category as their
message: `InvalidArgument`, `DuplicateId`, `NotFound`, `IOError`, `BadMagic`,
`BadVersion`, `OutOfMemory`, `PartialCompact`, `NotDurable` or `InternalError`.

For retrieval over text, index embeddings from `GGMLBert` in
[`@qvac/embed-llamacpp`](../embed-llamacpp): L2-normalize each document
embedding, add the rows with their chunk IDs, and search with the normalized
query embedding.

## Async API

A large build, search or load blocks the JS thread for as long as it runs,
and with it every other request the process is serving. The async variants run
the same native work on worker threads owned by this addon and return a
promise that resolves with the same value, or rejects with the same error, as
the sync method:

`addWithIdsAsync()`, `addLoggedAsync()`, `removeAsync()`,
`removeLoggedAsync()`, `compactAsync()`, `compactDeltaAsync()`,
`searchAsync()`, `searchFilteredAsync()`, `prepareFilterAsync()`,
`buildIvfAsync()`, `searchIvfAsync()`, `prepareAsync()`, `writeAsync()`,
`IdMapIndexFilter#searchAsync()`, and the static `loadAsync()`,
`loadMmapAsync()` and `loadWithDeltaAsync()`.

```javascript
const index = await IdMapIndex.loadAsync(snapshotPath)
try {
  await index.buildIvfAsync(256, 10)
  const { ids, scores } = await index.searchIvfAsync(query, 10, 16)
} finally {
  await index.disposeAsync()
}
```

- Async calls on one index run one at a time, in call order, so a search
  started after an add sees it.
- Across all indexes in the process, long work (adds, IVF builds, loads,
  writes, compaction, `prepareAsync()`, logged removes) runs on one worker
  thread and the rest (searches, `prepareFilterAsync()`, `removeAsync()`) on
  another. A long build therefore never holds up a search, but two builds take
  turns, and an add waits behind a build on another index. Each call runs on a
  single thread, as the sync calls do.
- While an async call on an index is queued or running, its sync methods and
  the `length`, `calibrated` and `stagedSearch` getters throw. `dim`,
  `bitWidth` and `dispose()` still work. Await the async work first, or use the
  async variants throughout.
- Input arrays are copied when the call is made, so they can be changed or
  transferred straight away. A large add briefly holds two copies of its
  vectors.
- `dispose()` during async work rejects the calls that have not started. A call
  that is running finishes, and the native index is freed after it.
  `disposeAsync()` resolves once it has been freed. A `prepareFilterAsync()`
  that was running when the index was disposed rejects.
- If the Bare environment shuts down, jobs that have not started are skipped.
  A running job still finishes before the environment is released.
- A started call cannot be cancelled. `buildIvfAsync()` runs to the end even
  when nothing awaits it any more.
- Each async call adds a few microseconds over the sync call; see
  `npm run benchmarks:async`.

## Development

```bash
npm install
npm run build             # TypeScript + native addon into prebuilds/
npm run test:integration  # IdMapIndex suite under Bare
npm run test:cpp          # C++ unit tests for the native wrapper
npm run lint
npm run benchmarks:cpu    # CPU benchmark across every storage mode
npm run benchmarks:async  # per-call latency of searchAsync() against search()
```

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
