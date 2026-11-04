# 💥 Breaking Changes v0.10.0

## Narrow the optional `@qvac/cli` peer to `^0.16.0`

Managed mode needs `@qvac/cli@^0.16.0`. `@qvac/cli@0.15.0` cannot satisfy that 0.x caret.

**BEFORE:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.15.0" } }
```

**AFTER:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.16.0" } }
```

```bash
npm install @qvac/ai-sdk-provider ai @ai-sdk/openai-compatible @qvac/cli@^0.16.0
```

---

## Drop Core ML bundle files from the provider catalog

PR: [#5012](https://github.com/tetherto/qvac/pull/5012)

**BEFORE:**

```typescript
import { PARAKEET_COREMLDATA } from '@qvac/ai-sdk-provider/models'
```

**AFTER:**

```typescript
// PARAKEET_COREMLDATA and the other .mlmodelc component constants are gone.
// Load the GGUF model. The bundle files are not models.
```

---

## Drop named exports for Qwen3.8 Flash Next UD shard constants

PR: [#5012](https://github.com/tetherto/qvac/pull/5012)

Named exports `QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q2_K_XL_SHARD` and `QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q4_K_XL_SHARD` are no longer exported. The sharded catalog entries remain on `allModels` with `shardMetadata`.

**BEFORE:**

```typescript
import { QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q2_K_XL_SHARD } from '@qvac/ai-sdk-provider/models'
```

**AFTER:**

```typescript
import { allModels } from '@qvac/ai-sdk-provider/models'

const qwenFlashNext = allModels.find(
  (m) => m.name === 'QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q2_K_XL_SHARD'
)
```

---
