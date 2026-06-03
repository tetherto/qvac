# 🔌 API Changes v0.12.1

## Surface bare worker crash and shutdown as RPC errors

PR: [#2350](https://github.com/tetherto/qvac/pull/2350)

```typescript
import { WorkerCrashedError, WorkerShutdownError } from "@qvac/sdk";

try {
  await sdk.embed({ modelId, text: "hi" });
} catch (err) {
  if (err instanceof WorkerCrashedError) {
    // err.exitCode, err.exitSignal — bare worker died unexpectedly.
  } else if (err instanceof WorkerShutdownError) {
    // SDK is shutting down; this call was in-flight when close() ran.
  }
}
```

---

