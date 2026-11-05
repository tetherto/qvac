# API changes v0.9.0

## Asynchronous TurboVec index providers

PR: [#5362](https://github.com/tetherto/qvac/pull/5362)

Providers can return an index immediately or resolve one asynchronously. This lets a provider dynamically import its native addon before creating or loading an index.

```typescript
import type { TurboVecIndexProvider } from '@qvac/rag'

async function useProvider(provider: TurboVecIndexProvider, snapshotPath: string) {
  const index = await provider.create({ dim: 8, storage: 'q8' })
  const restored = await provider.load(snapshotPath)
  index.dispose()
  restored.dispose()
}
```

`TurboVecAdapter` awaits creation and checkpoint loading during writes, rebuilds, and recovery. Queued mutations, storage fallback, scan-based search, and cleanup during close remain supported.
