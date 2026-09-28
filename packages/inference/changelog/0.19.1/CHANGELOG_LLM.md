# QVAC Inference v0.19.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.19.1

QVAC Inference 0.19.1 is a patch on the 0.19 line. Completion stats now report prompt-processing throughput, `deleteCache({ auto: true })` reclaims automatic KV caches without touching named ones, and `assessModelFit` can refuse a model from a computed floor when no calibration applies. `@qvac/rag` `^0.8.1` is the floor so Windows TurboVec installs the fixed package.

## New APIs

### Prompt-processing throughput

`CompletionStats.promptTokensPerSecond` is the addon's prefill (prompt-processing) rate. `tokensPerSecond` remains decode throughput. Both fields are optional; they appear on `completionStats` events and on the aggregated `final.stats` for single and batch completions.

```typescript
const run = completion({ modelId, history, stream: true })
const stats = await run.stats

stats?.tokensPerSecond // decode throughput
stats?.promptTokensPerSecond // prompt-processing (prefill) throughput
```

### Reclaim automatic KV caches

`deleteCache({ auto: true })` drops every automatic cache that no in-flight turn is holding. Named, caller-owned caches are left alone. `{ all: true }` still deletes everything, including named caches.

```typescript
import { deleteCache } from '@qvac/inference'

await deleteCache({ auto: true })
```

### Computed floor when no calibration applies

On platforms without a calibration fixture, `assessModelFit` used to return `unknown` even when the artifact plus KV cache already exceeded the budget. It now falls back to a computed floor (artifact bytes plus the llama.cpp KV cache at the narrowest default width). Over budget is `likely-too-large`; otherwise the verdict stays `unknown`. This path never returns `likely-fits`.

Android compares the floor to the `system-memory` budget. iOS compares it to the `process-memory` budget, which now uses the per-process allowance from `bare-os`. Discrete GPUs without coefficients stay `unknown`.

New result fields: `evidence` (`calibration` | `computed-only`) and `floorBytes`.

```typescript
import { assessModelFit, QWEN3_8B_INST_Q4_K_M } from '@qvac/inference'

const result = await assessModelFit({
  models: [
    {
      model: QWEN3_8B_INST_Q4_K_M,
      workload: { kind: 'llm', contextTokens: 8192 }
    }
  ]
})

result.verdict // "likely-fits" | "likely-too-large" | "unknown"
result.evidence // "calibration" | "computed-only"
result.floorBytes

if (result.evidence === 'computed-only' && result.verdict === 'unknown') {
  // uncalibrated, not a near-miss
}
```

## Features

iOS `sample.memory.processAvailableBytes` is sourced from `bare-os` `availableMemory()` so the `process-memory` budget can form. Other platforms leave that metric unavailable.

## Bug Fixes

`@qvac/inference` now requires `@qvac/rag` `^0.8.1`. 0.8.0 could not open a TurboVec workspace on Windows.
