# @qvac/turbovec-ggml

`IdMapIndex` is a synchronous CPU vector index with stable unsigned 64-bit IDs.
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
| `turbovec-q4` | 4 | v3 | No | No |
| `turbovec-q2` | 2 | v3 | No | No |

The default storage is `q8`. `bitWidth: 2` selects `turbovec-q2`, while `bitWidth: 4` selects generic `q4`; use `storage: 'turbovec-q4'` explicitly for TurboVec Q4.

TurboVec requires a 64-bit target and dimensions divisible by 8 and no greater than 1,024. It provides approximate rotated/quantized dot-product search. TurboVec snapshots support `write()` and `load()`, but reject mmap loading, delta-log loading, logged mutations, and delta compaction.

## Operations and lifecycle

- `addWithIds()`, `remove()`, `contains()`, and `compact()` mutate or inspect the index.
- `search()`, `searchFiltered()`, and `prepareFilter()` perform full-scan retrieval.
- `buildIvf()` enables approximate `searchIvf()` retrieval. IVF state is in-memory only and must be rebuilt after a mutation or snapshot load.
- `write()` and `load()` persist all storage modes. Generic `f32`, `q8`, and `q4` additionally support `loadMmap()`, `loadWithDelta()`, `addLogged()`, `removeLogged()`, and `compactDelta()`.
- Mutations invalidate prepared filters and IVF state.
- Call `dispose()` on indexes and prepared filters when finished. Disposal is idempotent.
- Every call runs synchronously on the calling thread.

Errors thrown by the native index carry the fabric error category as their
message: `InvalidArgument`, `DuplicateId`, `NotFound`, `IOError`, `BadMagic`,
`BadVersion`, `OutOfMemory`, `PartialCompact`, `NotDurable` or `InternalError`.

For retrieval over text, index embeddings from `GGMLBert` in
[`@qvac/embed-llamacpp`](../embed-llamacpp): L2-normalize each document
embedding, add the rows with their chunk IDs, and search with the normalized
query embedding.

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
