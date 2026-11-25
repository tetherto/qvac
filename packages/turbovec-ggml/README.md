# @qvac/turbovec-ggml

`IdMapIndex` is a CPU vector index with stable unsigned 64-bit IDs.
It stores vectors as full `f32`, generic `q8`/`q4` quantized codes, or
TurboVec `q4`/`q3`/`q2` codes searched directly in their quantized form.

The index runs on the vector-index API of the shared `@qvac/fabric` runtime,
which this addon links dynamically. It loads no ggml compute backends and
needs no model. Every call that reads or changes an index returns a promise
and runs on a worker thread owned by the addon, so a large build, search or
load never blocks the JS thread.

## Usage

```javascript
const IdMapIndex = require('@qvac/turbovec-ggml')

const index = new IdMapIndex({ dim: 768, storage: 'turbovec-q4' })
try {
  await index.addWithIds(vectors, new BigUint64Array([1n, 2n]))
  await index.prepare()
  const { ids, scores } = await index.search(query, 2)
} finally {
  await index.dispose()
}
```

The class is also exported as `IdMapIndex` (with `IdMapIndexFilter`), from the
package root and from the `@qvac/turbovec-ggml/idMapIndex` subpath, for both
CommonJS and ESM.

`vectors` contains row-major `Float32Array` data with one `dim`-sized row per ID. Queries use the same layout and may contain multiple rows. Search uses dot-product similarity; L2-normalize indexed vectors and queries first when cosine similarity is required. Results are ordered by descending score and then ascending ID; TurboVec storage orders equal scores by stored row instead (insertion order, reshuffled by removals and `buildIvf()`). Short result rows are padded with the ID `UINT64_MAX`, which is reserved and cannot be added.

## Storage modes

| Storage | Effective bits | Snapshot | Mmap | Delta log |
|---------|---------------:|----------|------|-----------|
| `f32` | 32 | v2 | Yes | Yes |
| `q8` | 8 | v2 | Yes | Yes |
| `q4` | 4 | v2 | Yes | Yes |
| `turbovec-q4` | 4 | v8 | No | No |
| `turbovec-q3` | 3 | v8 | No | No |
| `turbovec-q2` | 2 | v8 | No | No |

The default storage is `q8`. `bitWidth: 2` and `bitWidth: 3` select `turbovec-q2` and `turbovec-q3`, while `bitWidth: 4` selects generic `q4`; use `storage: 'turbovec-q4'` explicitly for TurboVec Q4. The `storage` getter reports the storage mode, which `bitWidth` alone cannot (4 is either `q4` or `turbovec-q4`).

TurboVec requires a 64-bit target and dimensions divisible by 8 and no greater than 16,384. It is a port of upstream turbovec 1.1.2 and provides approximate rotated/quantized dot-product search. TurboVec snapshots use turbovec's v8 container and support `write()` and `load()`, but reject mmap loading, delta-log loading, logged mutations, and delta compaction. Instead, `sync(path)` saves only what changed since the last sync to that path, and `toBytes()` / `IdMapIndex.fromBytes()` keep a snapshot in memory rather than in a file. v3 snapshots written by earlier releases still load, keep their encoding and keep writing v3; the `legacy` getter reports such an index, which supports neither `sync()` nor `toBytes()`.

A fresh TurboVec index fits its TQ+ calibration from its first `addWithIds()` batch when that batch has at least 1,000 rows (from up to 4,096 rows spread across a larger batch, fewer above 4,096 dimensions so the sample stays within 64 MiB), which improves recall. A smaller first batch leaves the index uncalibrated; it still works, without that gain. An empty or rejected first batch does not count, so the next one can still calibrate. The `calibrated` getter reports the state, and a loaded index keeps the state it was saved with.

Staged search is off for every new or loaded TurboVec index, so a search scores every vector. `setStagedSearch(true)` turns on upstream's staged search: from 32,768 vectors it scans a compressed form first and scores only a shortlist, several times faster per query but with lower recall, most of all at small k. It applies only at a dimension divisible by 32, on hosts that support it, and never to `turbovec-q3` or to an index loaded from a v3 snapshot; elsewhere the setting is kept but every search scans in full. The setting is not saved in snapshots, `stagedSearch` reports it, and other storages reject it.

## Operations and lifecycle

- `addWithIds()`, `remove()`, `contains()`, and `compact()` mutate or inspect the index.
- `search()`, `searchFiltered()`, and `prepareFilter()` perform full-scan retrieval.
- `buildIvf()` enables approximate `searchIvf()` retrieval. IVF state is in-memory only and must be rebuilt after a mutation or snapshot load.
- `ids()` resolves to every live ID as a `BigUint64Array`, in an order that stays the same until the index changes (on TurboVec storage, also until `buildIvf()`).
- `write()` and the static `load()` persist all storage modes. `write(path, { durability: 'fast' })` skips the fsyncs: the file is still replaced atomically and survives a process crash, but a power loss soon after may lose it, and a delta log cannot start from it. Generic `f32`, `q8`, and `q4` additionally support `loadMmap()`, `loadWithDelta()`, `addLogged()`, `removeLogged()`, and `compactDelta()`. An index written to a snapshot takes either logged or plain mutations, not both.
- TurboVec storage additionally supports `sync()`, `toBytes()` and the static `fromBytes()`. The first `sync()` to a path, and the first after a calibration or `buildIvf()`, writes the whole file; later ones write only the changed blocks. Each sync is durable, and a crash at any point leaves the previous sync loadable. An index loaded from a synced file keeps syncing to it. One index may sync to a path at a time: when another has changed the file, `sync()` rejects with `IOError` and the file must be loaded again.
- Mutations invalidate prepared filters and IVF state. `buildIvf()` also disposes prepared filters: on TurboVec storage it regroups the stored rows by IVF list.
- Each of these returns a promise. Bad arguments reject too; only the
  constructor throws.
- The `length`, `dim`, `bitWidth`, `storage`, `calibrated`, `stagedSearch`,
  `threads` and `legacy` getters are synchronous and never wait. `length`,
  `calibrated`, `stagedSearch` and `threads` report the state after the last
  call that finished.
- Call `dispose()` on indexes and prepared filters when finished. Disposal is
  idempotent. Both return a promise that resolves once the native index or
  filter has been freed, and rejects if freeing it fails.

Native errors are inference-addon-cpp `StatusError`s, as in the other addons:
`error.code` is `"[ TurboVec :: <category> ]"`. An error from the native index
also carries its category as `error.message`: `InvalidArgument`,
`DuplicateId`, `NotFound`, `IOError`, `BadMagic`, `BadVersion`,
`OutOfMemory`, `PartialCompact`, `NotDurable` or `InternalError`.

For retrieval over text, index embeddings from `GGMLBert` in
[`@qvac/embed-llamacpp`](../embed-llamacpp): L2-normalize each document
embedding, add the rows with their chunk IDs, and search with the normalized
query embedding.

## Threads, ordering and cancellation

```javascript
// Bare has no built-in AbortSignal: install bare-abort-controller yourself.
const { AbortSignal } = require('bare-abort-controller')

const index = await IdMapIndex.load(snapshotPath)
try {
  // Stops waiting after 30 s. A build that has started still runs to the end.
  await index.buildIvf(256, 10, { signal: AbortSignal.timeout(30_000) })
  const { ids, scores } = await index.searchIvf(query, 10, 16)
} finally {
  await index.dispose()
}
```

- Calls on one index run one at a time, in call order, so a search started
  after an add sees it.
- Across all indexes in the process, long work (adds, IVF builds, loads,
  writes, syncs, `toBytes()`, compaction, `prepare()`, `prepareFilter()`,
  `setStagedSearch()`, logged removes) runs on one worker thread and the rest
  (searches, `ids()`, `remove()`) on another. A long
  build or a large allow-list therefore never holds up a search, but two
  builds take turns, and an add waits behind a build on another index. The
  jobs run through inference-addon-cpp's `JsAsyncTask`, on these two threads.
- By default each call runs on that one worker thread. The `threads`
  constructor option, or `setThreads(n)` for an existing or loaded index,
  lets searches, adds and TurboVec calibration on that index split their
  work across up to `n` threads (1 to 256, the worker thread included).
  Results do not change with the count. The extra threads come from one pool
  in `@qvac/fabric` shared by every index in the process, started on first
  use. A search splits its queries across the threads; a search with fewer
  queries than threads splits a TurboVec index of 32,768 or more vectors
  instead. The count is not saved in snapshots, so a loaded index starts
  at 1.
- Input arrays are copied when the call is made, including calls that wait
  behind other work on the same index, so they can be changed or transferred
  straight away. A large add holds one extra copy of its vectors until it
  finishes.
- `dispose()` rejects the calls that have not started. A call that is running
  finishes, and the native index is freed after it. A `prepareFilter()` that
  was running when the index was disposed rejects.
- Every call takes an optional `{ signal }`: an `AbortSignal`, such as one from
  `bare-abort-controller`. A call that has not started when the signal aborts
  is skipped, including one that is already waiting for a worker thread
  behind work on another index. A call that is running rejects at once with
  `signal.reason`, but
  its native work runs to the end: a search's result is dropped, a loaded
  index or prepared filter is freed, and a mutation such as `addWithIds()` or
  `buildIvf()` still takes effect. Later calls on that index wait for the
  native work to finish.
- If the Bare environment shuts down, its jobs that have not started are
  dropped. A running job still finishes before the environment is released.

## Development

```bash
npm install
npm run build             # TypeScript + native addon into prebuilds/
npm run test:integration  # IdMapIndex suite under Bare
npm run test:cpp          # C++ unit tests for the native wrapper
npm run lint
npm run benchmarks:cpu    # CPU benchmark across every storage mode
```

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
