# QVAC SDK v0.13.4 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.13.4

A patch release that adds two developer-experience APIs — a single subscription
for all server logs and friendlier input-validation errors — and hardens
tool-call parsing for Qwen models used in agentic workflows.

## New APIs

### Subscribe to all server logs at once

You can now capture every server-side log through one subscription instead of
wiring up a `loggingStream()` per model or request. `subscribeServerLogs`
delivers each log entry (level, namespace, message) to a single handler and
returns an unsubscribe function.

```typescript
import { subscribeServerLogs } from "@qvac/sdk";

const unsubscribe = subscribeServerLogs((log) => {
  console.log(`[${log.level}] [${log.namespace}] ${log.message}`);
});

// later
unsubscribe();
```

### Field-level validation errors for user input

Invalid request input now surfaces as a `RequestValidationFailedError` with a
clear, field-level message pointing at the exact key and location that failed,
instead of an opaque rejection. This makes it much faster to spot typos and
unsupported options in calls like `loadModel`.

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

## Bug Fixes

### Recover malformed Qwen tool-call frames

Qwen3.5/3.6 can intermittently emit a malformed tool-call frame that fuses its
XML and JSON tool templates, embedding the `function=<name>` token as a bare
string key inside an otherwise JSON object. Previously the parser rejected that
frame as invalid JSON, so no structured tool call was produced and callers saw
the raw markup as assistant text. The parser now recognizes and repairs this
specific shape, so the tool call is recovered and dispatched correctly.
