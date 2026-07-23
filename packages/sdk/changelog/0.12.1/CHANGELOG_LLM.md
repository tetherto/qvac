# QVAC SDK v0.12.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.12.1

This is a patch release on top of v0.12.0. It surfaces two new error classes so callers can distinguish a crashed bare worker from an in-flight call cancelled by SDK shutdown, and it fixes a Qwen 3.5/3.6 tool-call regression where capitalised booleans were silently dropping the entire tool call.

## New APIs

### Distinguish bare worker crashes from shutdown cancellations

Calls made through a bare worker (e.g. `sdk.embed`, `sdk.complete`) previously rejected with a generic RPC error if the worker process died mid-request or if `sdk.close()` was called while the request was in flight. Both cases looked identical to callers, so retry/UX logic had to guess.

v0.12.1 introduces two structured RPC errors that propagate from the worker bridge:

- `WorkerCrashedError` — the bare worker died unexpectedly. Exposes `exitCode` and `exitSignal` so you can tell a SIGKILL from a clean non-zero exit and decide whether to respawn.
- `WorkerShutdownError` — the SDK is shutting down (`sdk.close()` was called) while this request was still in flight. Safe to swallow on intentional teardown; surfaces an actionable label for callers who want to log it.

```typescript
import { WorkerCrashedError, WorkerShutdownError } from "@qvac/sdk";

try {
  await sdk.embed({ modelId, text: "hi" });
} catch (err) {
  if (err instanceof WorkerCrashedError) {
    // err.exitCode, err.exitSignal — worker died, decide whether to respawn.
  } else if (err instanceof WorkerShutdownError) {
    // SDK is shutting down; this call was cancelled by close().
  }
}
```

Existing `catch (err)` blocks that don't narrow by class continue to work unchanged — the new classes both extend the same RPC error base.

## Bug Fixes

### Qwen 3.5/3.6 tool calls with capitalised booleans no longer drop silently

Qwen 3.5/3.6 (the default tool-calling family) intermittently emits Python-style `True` / `False` for `boolean` parameters instead of the JSON-strict `true` / `false`. The qwen35 parser only accepted the exact lowercase literals, so coercion threw, the parser returned an empty `toolCalls` array, and the raw `<tool_call>…</tool_call>` markup leaked into the assistant's final text answer — there was no `PARSE_ERROR`, the tool call just vanished.

v0.12.1 lowercases the value before comparing in the boolean coercion path, so `True`, `False`, `TRUE`, and `FALSE` all coerce correctly. Genuinely invalid values (`maybe`, `0`, `null`) still throw `PARSE_ERROR` — the relaxation is intentionally scoped to casing. Other tool-call dialects are unaffected.
