# QVAC RAG v0.8.0 Release Notes

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
