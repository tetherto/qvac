# 💥 Breaking Changes v0.21.0

## Assess a model fit in loadModel's own parameters

PR: [#4670](https://github.com/tetherto/qvac/pull/4670)

**BEFORE:**

```typescript
await assessModelFit({
  models: [
    {
      model: LLAMA_3_2_1B,
      workload: { kind: 'llm', contextTokens: 4096 },
      artifacts: [MMPROJ_F16]
    }
  ]
})
```

**AFTER:**

```typescript
await assessModelFit({
  models: [
    {
      modelSrc: LLAMA_3_2_1B,
      modelType: 'llamacpp-completion',
      modelConfig: { ctx_size: 4096, projectionModelSrc: MMPROJ_F16 }
    }
  ]
})
```

Field by field:

| Before                                     | After                                                                                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`                                    | `modelSrc`, plus optional `modelType` naming the engine when `modelSrc` does not                                                                                                               |
| `workload: { kind: 'llm', contextTokens }` | `modelConfig: { ctx_size }`. Omitting it sizes the load at the model's trained context.                                                                                                        |
| `workload: { kind: 'audio', windowMs }`    | `modelConfig: { duration_ms }`, capped at the engine's 30 s window                                                                                                                             |
| `workload: { kind: 'audio', streaming }`   | `modelConfig: { streaming }`, on the engines whose load takes it                                                                                                                               |
| `workload: { kind: 'audio', batch }`       | Removed. No engine takes a batch size at load time, so it has no equivalent in `loadModel`'s parameters.                                                                                       |
| `artifacts: [...]`                         | The companion `*ModelSrc` fields inside `modelConfig`, where the load already carries them. A companion the catalog cannot profile makes the candidate `unknown` rather than counting nothing. |

`modelType` is optional and inferred from `modelSrc` when omitted, the same way `loadModel` infers it. Required only where the source names no engine. A load whose sources are all config fields may omit `modelSrc`.

---

## Flatten the native fit-probe projection

PR: [#4671](https://github.com/tetherto/qvac/pull/4671)

**BEFORE:**

```typescript
info.fitProbe?.projection?.devices // NativeProbeDevice[]: per-device totals, free, margin, model, context, compute
```

**AFTER:**

```typescript
info.fitProbe?.projection?.deviceBytes
info.fitProbe?.projection?.hostBytes
info.fitProbe?.projection?.weightsBytes
info.fitProbe?.projection?.contextBytes
info.fitProbe?.projection?.computeBytes
info.fitProbe?.projection?.deviceName
```

`NativeProbeDevice` and `projection.devices` are gone. Totals are summed across devices; `deviceName` names the first.

---

## Update registry models

PR: [#4742](https://github.com/tetherto/qvac/pull/4742)

**BEFORE:**

```typescript
import { BITNET_0_7B_INST_TQ2_0 } from '@qvac/sdk'
import { BITNET_1B_INST_TQ2_0 } from '@qvac/sdk'
import { BITNET_B1_58_3B_INST_TQ2_0 } from '@qvac/sdk'
import { LLAMA_TOOL_CALLING_1B_INST_Q4_K } from '@qvac/sdk'
import { PARAKEET_INDIC_CONFORMER_CTC_Q4_0 } from '@qvac/sdk'
```

**AFTER:**

```typescript
import { BITNET_0_7B_BASE_TQ2_0 } from '@qvac/sdk'
import { BITNET_1B_BASE_TQ2_0 } from '@qvac/sdk'
import { BITNET_B1_58_3B_BASE_TQ2_0 } from '@qvac/sdk'
import { LLAMA_TOOL_CALLING_1B_INST_Q4_K_M } from '@qvac/sdk'
import { PARAKEET_INDIC_CONFORMER_600M_Q4_0 } from '@qvac/sdk'
```

---
