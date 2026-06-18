# 🔌 API Changes v0.13.4

## Add `subscribeServerLogs` to capture all server logs

PR: [#2558](https://github.com/tetherto/qvac/pull/2558)

```typescript
import { subscribeServerLogs } from "@qvac/sdk";

// One handler for every server-side log — no per-ID loggingStream() calls.
const unsubscribe = subscribeServerLogs((log) => {
  console.log(`[${log.level}] [${log.namespace}] ${log.message}`);
});

// later
unsubscribe();
```

---

## Friendly, field-level validation errors for user input

PR: [#2618](https://github.com/tetherto/qvac/pull/2618)

```typescript
import { loadModel, RequestValidationFailedError, LLAMA_3_2_1B_INST_Q4_0 } from "@qvac/sdk";

try {
  await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelConfig: { dtx_size: 4096 } });
} catch (err) {
  if (err instanceof RequestValidationFailedError) {
    console.error(err.message);
    // Invalid request:
    // ✖ Unrecognized key: "dtx_size"
    //   → at modelConfig
  }
}
```

---

