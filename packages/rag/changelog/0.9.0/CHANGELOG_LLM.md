# QVAC RAG v0.9.0 Release Notes

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
