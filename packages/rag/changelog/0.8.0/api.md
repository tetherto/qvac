# 🔌 API Changes v0.8.0

## Add TurboVec adapter with journaled HyperDB recovery

PR: [#4073](https://github.com/tetherto/qvac/pull/4073)

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

---
