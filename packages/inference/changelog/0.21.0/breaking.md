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
| `model`                                    | `modelSrc`, plus `modelType` naming the engine                                                                                                                                                 |
| `workload: { kind: 'llm', contextTokens }` | `modelConfig: { ctx_size }`. Omitting it sizes the load at the model's trained context.                                                                                                        |
| `workload: { kind: 'audio', windowMs }`    | `modelConfig: { duration_ms }`, capped at the engine's 30 s window                                                                                                                             |
| `workload: { kind: 'audio', streaming }`   | `modelConfig: { streaming }`, on the engines whose load takes it                                                                                                                               |
| `workload: { kind: 'audio', batch }`       | Removed. No engine takes a batch size at load time, so it has no equivalent in `loadModel`'s parameters.                                                                                       |
| `artifacts: [...]`                         | The companion `*ModelSrc` fields inside `modelConfig`, where the load already carries them. A companion the catalog cannot profile makes the candidate `unknown` rather than counting nothing. |

`modelType` is required, and a load whose sources are all config fields may omit `modelSrc`.

---

## Update registry models

PR: [#4742](https://github.com/tetherto/qvac/pull/4742)

**BEFORE:**

```typescript
import { BITNET_0_7B_INST_TQ2_0 } from '@qvac/inference'
import { BITNET_1B_INST_TQ2_0 } from '@qvac/inference'
import { BITNET_B1_58_3B_INST_TQ2_0 } from '@qvac/inference'
import { LLAMA_TOOL_CALLING_1B_INST_Q4_K } from '@qvac/inference'
import { PARAKEET_INDIC_CONFORMER_CTC_Q4_0 } from '@qvac/inference'
```

**AFTER:**

```typescript
import { BITNET_0_7B_BASE_TQ2_0 } from '@qvac/inference'
import { BITNET_1B_BASE_TQ2_0 } from '@qvac/inference'
import { BITNET_B1_58_3B_BASE_TQ2_0 } from '@qvac/inference'
import { LLAMA_TOOL_CALLING_1B_INST_Q4_K_M } from '@qvac/inference'
import { PARAKEET_INDIC_CONFORMER_600M_Q4_0 } from '@qvac/inference'
```
