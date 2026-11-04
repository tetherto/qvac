# Breaking changes v0.9.0

## Await direct calls to TurboVec index providers

PR: [#5362](https://github.com/tetherto/qvac/pull/5362)

`TurboVecIndexProvider.create()` and `load()` now return `TurboVecIndex | Promise<TurboVecIndex>`. Code that calls these methods through the provider interface must await the result before using the index.

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

Existing synchronous provider implementations remain supported. `TurboVecAdapter` awaits provider initialization internally, so code that uses the adapter without calling the provider directly needs no changes.
