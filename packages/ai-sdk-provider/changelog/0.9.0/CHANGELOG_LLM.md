# QVAC AI SDK Provider v0.9.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.9.0

QVAC AI SDK Provider 0.9.0 follows `@qvac/cli` 0.15.0. The catalog picks up Ternary Bonsai 2 27B, MOSS TTS, Indic Parakeet 600M GGUFs, and CosyVoice3 quant variants. BitNet instructed TQ2_0 exports are retagged as base, Llama tool-calling 1B moves to `Q4_K_M`, and Indic Parakeet Conformer CTC constants are removed.

Managed mode needs `@qvac/cli@^0.15.0`. Publish after CLI 0.15.0 is on npm. External mode is unchanged.

## Breaking Changes

### Managed mode requires `@qvac/cli` 0.15

The optional CLI peer narrows to `^0.15.0`. 0.14 cannot satisfy that range.

**Before:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.14.0" } }
```

**After:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.15.0" } }
```

```bash
npm install @qvac/ai-sdk-provider ai @ai-sdk/openai-compatible @qvac/cli@^0.15.0
```

### Catalog constant names

BitNet instructed TQ2_0 exports are retagged as base. Llama tool-calling 1B moves from `Q4_K` to `Q4_K_M`. Indic Parakeet Conformer CTC constants are replaced by the 600M GGUFs.

**Before:**

```typescript
import { BITNET_0_7B_INST_TQ2_0 } from '@qvac/ai-sdk-provider'
import { LLAMA_TOOL_CALLING_1B_INST_Q4_K } from '@qvac/ai-sdk-provider'
import { PARAKEET_INDIC_CONFORMER_CTC_Q4_0 } from '@qvac/ai-sdk-provider'
```

**After:**

```typescript
import { BITNET_0_7B_BASE_TQ2_0 } from '@qvac/ai-sdk-provider'
import { LLAMA_TOOL_CALLING_1B_INST_Q4_K_M } from '@qvac/ai-sdk-provider'
import { PARAKEET_INDIC_CONFORMER_600M_Q4_0 } from '@qvac/ai-sdk-provider'
```

## Model Changes

### Added

```
BITNET_0_7B_BASE_TQ2_0
BITNET_1B_BASE_TQ2_0
BITNET_B1_58_3B_BASE_TQ2_0
LLAMA_TOOL_CALLING_1B_INST_Q4_K_M
MMPROJ_TERNARY_BONSAI_2_27B_MULTIMODAL_Q8_0
PARAKEET_INDIC_CONFORMER_600M_F16
PARAKEET_INDIC_CONFORMER_600M_Q4_0
PARAKEET_INDIC_CONFORMER_600M_Q8_0
PARAKEET_TDT_1_1B_F16
PARAKEET_TDT_1_1B_Q8_0
TERNARY_BONSAI_2_27B_MULTIMODAL_PQ2_0
TERNARY_BONSAI_2_27B_MULTIMODAL_PTQ1_0
TTS_CODEC_DECODER_MOSS_TTS_F16
TTS_CODEC_ENCODER_MOSS_TTS_F16
TTS_COSYVOICE3_FLOW_COSYVOICE_BF16
TTS_COSYVOICE3_FLOW_COSYVOICE_FP16
TTS_COSYVOICE3_FLOW_COSYVOICE_Q4_0
TTS_COSYVOICE3_FLOW_COSYVOICE_Q8_0
TTS_COSYVOICE3_HIFT_COSYVOICE_FP16
TTS_COSYVOICE3_LLM_COSYVOICE_FUSED_Q8_0
TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0
TTS_DELAY_LLM_MOSS_TTS_F16
```

Parakeet Core ML sidecars download beside those GGUFs on Apple hosts. They are not independently loadable.

### Removed

```
BITNET_0_7B_INST_TQ2_0
BITNET_1B_INST_TQ2_0
BITNET_B1_58_3B_INST_TQ2_0
LLAMA_TOOL_CALLING_1B_INST_Q4_K
PARAKEET_INDIC_CONFORMER_CTC_F16
PARAKEET_INDIC_CONFORMER_CTC_Q4_0
PARAKEET_INDIC_CONFORMER_CTC_Q8_0
```
