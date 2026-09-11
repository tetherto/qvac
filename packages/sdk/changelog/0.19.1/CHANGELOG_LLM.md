# QVAC SDK v0.19.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.19.1

QVAC SDK 0.19.1 is a patch on the 0.19 line. Completion stats now report prompt-processing throughput, `deleteCache({ auto: true })` reclaims automatic KV caches without touching named ones, and `assessModelFit` can refuse a model from a computed floor when no calibration applies. Mobile `withQvacSDK` bundles no longer pull in the desktop-only fit subprocess, and `@qvac/rag` `^0.8.1` is the floor so Windows TurboVec installs the fixed package.

`@qvac/sdk`, `@qvac/inference`, and `tetherto-qvac-sdk` all ship at 0.19.1. Install `@qvac/sdk` and `@qvac/inference` together at this version.

## New APIs

### Prompt-processing throughput

`CompletionStats.promptTokensPerSecond` is the addon's prefill (prompt-processing) rate. `tokensPerSecond` remains decode throughput. Both fields are optional; they appear on `completionStats` events and on the aggregated `final.stats` for single and batch completions. The Python client models include the same field.

```typescript
const run = completion({ modelId, history, stream: true })
const stats = await run.stats

stats?.tokensPerSecond // decode throughput
stats?.promptTokensPerSecond // prompt-processing (prefill) throughput
```

### Reclaim automatic KV caches

`deleteCache({ auto: true })` drops every automatic cache that no in-flight turn is holding. Named, caller-owned caches are left alone. `{ all: true }` still deletes everything, including named caches.

```typescript
import { deleteCache } from '@qvac/sdk'

await deleteCache({ auto: true })
```

### Computed floor when no calibration applies

On platforms without a calibration fixture, `assessModelFit` used to return `unknown` even when the artifact plus KV cache already exceeded the budget. It now falls back to a computed floor (artifact bytes plus the llama.cpp KV cache at the narrowest default width). Over budget is `likely-too-large`; otherwise the verdict stays `unknown`. This path never returns `likely-fits`.

Android compares the floor to the `system-memory` budget. iOS compares it to the `process-memory` budget, which now uses the per-process allowance from `bare-os`. Discrete GPUs without coefficients stay `unknown`.

New result fields: `evidence` (`calibration` | `computed-only`) and `floorBytes`.

```typescript
import { assessModelFit, QWEN3_8B_INST_Q4_K_M } from '@qvac/sdk'

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

if (result.evidence === "computed-only" && result.verdict === "unknown") {
  // uncalibrated, not a near-miss
}
```

The assess-model-fit doc now includes a platform support matrix and a table of every `unknown` reason.

## Features

iOS `sample.memory.processAvailableBytes` is sourced from `bare-os` `availableMemory()` so the `process-memory` budget can form. Other platforms leave that metric unavailable.

## Bug Fixes

`withQvacSDK` mobile bundles defer `bare-runtime/spawn` and `@qvac/model-fit/process`, so expo prebuild no longer fails looking for a `bare-posix` android-arm64 prebuild that does not exist. Desktop advisory fit is unchanged.

`@qvac/inference` now requires `@qvac/rag` `^0.8.1`. 0.8.0 could not open a TurboVec workspace on Windows.

