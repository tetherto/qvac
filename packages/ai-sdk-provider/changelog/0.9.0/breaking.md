# 💥 Breaking Changes v0.9.0

## Narrow the optional `@qvac/cli` peer to `^0.15.0`

Managed mode needs `@qvac/cli@^0.15.0`. `@qvac/cli@0.14.0` cannot satisfy that 0.x caret.

**BEFORE:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.14.0" } }
```

**AFTER:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.15.0" } }
```

```bash
npm install @qvac/ai-sdk-provider ai @ai-sdk/openai-compatible @qvac/cli@^0.15.0
```

---

## Update registry models

PR: [#4742](https://github.com/tetherto/qvac/pull/4742)

Exported `constants.ts` names are the provider API. BitNet instructed TQ2_0 exports are retagged as base. Llama tool-calling 1B moves from `Q4_K` to `Q4_K_M`. Indic Parakeet Conformer CTC constants are replaced by the 600M GGUFs.

**BEFORE:**

```typescript
import { BITNET_0_7B_INST_TQ2_0 } from '@qvac/ai-sdk-provider'
import { LLAMA_TOOL_CALLING_1B_INST_Q4_K } from '@qvac/ai-sdk-provider'
import { PARAKEET_INDIC_CONFORMER_CTC_Q4_0 } from '@qvac/ai-sdk-provider'
```

**AFTER:**

```typescript
import { BITNET_0_7B_BASE_TQ2_0 } from '@qvac/ai-sdk-provider'
import { LLAMA_TOOL_CALLING_1B_INST_Q4_K_M } from '@qvac/ai-sdk-provider'
import { PARAKEET_INDIC_CONFORMER_600M_Q4_0 } from '@qvac/ai-sdk-provider'
```

---
