# QVAC RAG v0.9.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.9.1

This patch makes `TurboVecAdapter` work with `@qvac/turbovec-ggml` 0.7, where every index method returns a promise. With 0.9.0 on turbovec 0.7, every native search threw, a failed add or remove escaped as an unhandled rejection, and a checkpoint renamed its snapshot before the index had finished writing it. Indexes that return their results directly, such as turbovec 0.5 and earlier, still work.

## Fixed

### TurboVec 0.7 indexes

`TurboVecAdapter` awaits every index call: search, add, remove, prepare, write and dispose. A failed add or remove marks the index for a rebuild again, as it did with synchronous indexes. A checkpoint waits for the snapshot write to finish before it renames the file into place.

### Searches during index updates

A rebuild disposes the index it replaces, and turbovec 0.7 rejects calls still queued on a disposed index. A search that was waiting on the old index now scans HyperDB instead of failing. Upserts and journal replays wait for each remove to finish before adding vectors. Searches scan HyperDB while an index mutation is in progress or when native candidates come from a different revision than the HyperDB snapshot.

## Changed

### `TurboVecIndex` methods may return promises

Each `TurboVecIndex` method now returns its result or a promise of it, so the turbovec 0.7 `IdMapIndex` fits the interface. `length` and `dim` stay synchronous. Code that calls an index through this interface should await each call. Code that derives the search result type from the interface should use the exported `TurboVecIndexSearchResult` instead.

Before:

```typescript
type SearchResult = ReturnType<TurboVecIndex['search']>
const result = index.search(queries, 10)
```

After:

```typescript
import type { TurboVecIndexSearchResult } from '@qvac/rag'

const result: TurboVecIndexSearchResult = await index.search(queries, 10)
```

Code that uses `TurboVecAdapter` without calling index methods itself needs no changes.
