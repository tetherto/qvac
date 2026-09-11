# 🔌 API Changes v0.19.1

## Add deleteCache({ auto: true }) to reclaim automatic KV caches

PR: [#4248](https://github.com/tetherto/qvac/pull/4248)

```typescript
import { deleteCache } from '@qvac/sdk'

// Reclaim automatic caches; caller-owned named caches are untouched.
await deleteCache({ auto: true })
```

---

## Pass prompt-processing throughput through completion stats

PR: [#4295](https://github.com/tetherto/qvac/pull/4295)

```typescript
const run = completion({ modelId, history, stream: true })
const stats = await run.stats

stats?.tokensPerSecond // decode throughput
stats?.promptTokensPerSecond // prompt-processing (prefill) throughput
```

---

## Refuse from the computed floor when no calibration applies

PR: [#4358](https://github.com/tetherto/qvac/pull/4358)

```typescript
const result = await assessModelFit({ models: [{ model: QWEN3_8B_INST_Q4_K_M, workload: { kind: 'llm', contextTokens: 8192 } }] })
// android-arm64: { verdict: 'likely-too-large', basis: 'system-memory',  evidence: 'computed-only', floorBytes: 5425000000, ... }
// ios-arm64:     { verdict: 'likely-too-large', basis: 'process-memory', evidence: 'computed-only', floorBytes: 5425000000, ... }
if (result.evidence === 'computed-only' && result.verdict === 'unknown') {
  // uncalibrated, not a near-miss
}
```

---

