# 💥 Breaking Changes v0.12.0

## Remove the inert runIdStrategy config field

PR: [#4451](https://github.com/tetherto/qvac/pull/4451)

**BEFORE:**
```typescript
import { defineConfig } from '@qvac/test-suite'

// Required by the compiler, and inert at runtime — it selected nothing.
export default defineConfig({
  testDir: './dist/tests',
  runIdStrategy: 'auto',
  consumers: { desktop: { entry: './consumer.js' } }
})
```

**AFTER:**
```typescript
import { defineConfig } from '@qvac/test-suite'

export default defineConfig({
  testDir: './dist/tests',
  consumers: { desktop: { entry: './consumer.js' } }
})
```

Consumers that set the field just delete the line. Nobody needs to replace it with anything: pass `--runId` when a run needs a specific id, which is what CI already does.

---

