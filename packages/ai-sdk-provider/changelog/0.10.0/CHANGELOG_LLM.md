# QVAC AI SDK Provider v0.10.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.10.0

QVAC AI SDK Provider 0.10.0 follows `@qvac/cli` 0.16.0. Managed mode verifies the listener before sending it the API key, the catalog adds Nemotron 3 diarization and four MOSS TTS constants, and Core ML bundle-file constants plus two Qwen3.8 Flash Next UD shard named exports are dropped.

The optional `@qvac/cli` peer is now `^0.16.0`. External mode is unchanged.

## Breaking Changes

### Managed mode requires `@qvac/cli` 0.16

Managed mode needs `@qvac/cli@^0.16.0`. `@qvac/cli@0.15.0` cannot satisfy that 0.x caret.

**Before:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.15.0" } }
```

**After:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.16.0" } }
```

```bash
npm install @qvac/ai-sdk-provider ai @ai-sdk/openai-compatible @qvac/cli@^0.16.0
```

### Core ML bundle files leave the catalog

Parakeet `.mlmodelc` component constants are gone. They were not independently loadable models. Load the GGUF instead.

**Before:**

```typescript
import { PARAKEET_COREMLDATA } from '@qvac/ai-sdk-provider/models'
```

**After:**

```typescript
// PARAKEET_COREMLDATA and the other .mlmodelc component constants are gone.
// Load the GGUF model. The bundle files are not models.
```

### Qwen3.8 Flash Next UD shard named exports

Named exports `QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q2_K_XL_SHARD` and `QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q4_K_XL_SHARD` are no longer exported. The sharded catalog entries remain on `allModels` with `shardMetadata`.

**Before:**

```typescript
import { QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q2_K_XL_SHARD } from '@qvac/ai-sdk-provider/models'
```

**After:**

```typescript
import { allModels } from '@qvac/ai-sdk-provider/models'

const qwenFlashNext = allModels.find(
  (m) => m.name === 'QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q2_K_XL_SHARD'
)
```

## New APIs

### Verify the managed serve before sending the key

A new managed serve reports the port it bound on a pipe only the provider can read (`qvac serve --ready-fd`). A reused serve must answer `GET /qvac/identity` before the provider sends the key. An older CLI that cannot report the bound port fails with `CliUpgradeRequiredError`.

```typescript
import { createQvac, CliUpgradeRequiredError } from '@qvac/ai-sdk-provider'

try {
  await createQvac({ mode: 'managed', models: ['qwen3.5-9b'] })
} catch (err) {
  if (err instanceof CliUpgradeRequiredError) {
    // err.code === 'CLI_UPGRADE_REQUIRED': install @qvac/cli >= 0.16.0
  }
}
```

### Nemotron diarization constant

The catalog adds a Nemotron 3 diarization GGUF constant. MOSS transcribe/diarize catalog names live on `@qvac/sdk`, not this package.

```typescript
import { PARAKEET_NEMOTRON_3_DIARIZATION_Q8_0 } from '@qvac/ai-sdk-provider/models'
```

### MOSS TTS constants

Four MOSS speech GGUF constants are now named exports. Transcribe/diarize MOSS names remain on `@qvac/sdk`.

```typescript
import {
  TTS_CODEC_MOSS_SPEECH_F16,
  TTS_DIALOGUE_MULTILINGUAL_MOSS_TTSD_F16,
  TTS_MOSS_SPEECH_BF16,
  TTS_MOSS_SPEECH_Q8_0
} from '@qvac/ai-sdk-provider/models'
```

## Model Changes

### Added

```
PARAKEET_NEMOTRON_3_DIARIZATION_Q8_0
TTS_CODEC_MOSS_SPEECH_F16
TTS_DIALOGUE_MULTILINGUAL_MOSS_TTSD_F16
TTS_MOSS_SPEECH_BF16
TTS_MOSS_SPEECH_Q8_0
```

### Removed

```
PARAKEET_COREMLDATA
PARAKEET_COREMLDATA_1
PARAKEET_COREMLDATA_2
PARAKEET_COREMLDATA_3
PARAKEET_COREMLDATA_4
PARAKEET_COREMLDATA_5
PARAKEET_CTC_COREMLDATA
PARAKEET_CTC_COREMLDATA_1
PARAKEET_CTC_WEIGHT
PARAKEET_INDIC_CONFORMER_COREMLDATA
PARAKEET_INDIC_CONFORMER_COREMLDATA_1
PARAKEET_INDIC_CONFORMER_MODEL
PARAKEET_INDIC_CONFORMER_WEIGHT
PARAKEET_METADATA_1
PARAKEET_METADATA_2
PARAKEET_MODEL
PARAKEET_MODEL_1
PARAKEET_MODEL_2
PARAKEET_NEMOTRON_COREMLDATA
PARAKEET_NEMOTRON_COREMLDATA_1
PARAKEET_NEMOTRON_MODEL
PARAKEET_NEMOTRON_WEIGHT
PARAKEET_TDT_COREMLDATA
PARAKEET_TDT_COREMLDATA_1
PARAKEET_TDT_COREMLDATA_2
PARAKEET_TDT_COREMLDATA_3
PARAKEET_TDT_METADATA_1
PARAKEET_TDT_MODEL
PARAKEET_TDT_MODEL_1
PARAKEET_TDT_WEIGHT
PARAKEET_TDT_WEIGHT_1
PARAKEET_UNIFIED_COREMLDATA
PARAKEET_UNIFIED_MODEL
PARAKEET_UNIFIED_WEIGHT
PARAKEET_WEIGHT
PARAKEET_WEIGHT_1
PARAKEET_WEIGHT_2
QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q2_K_XL_SHARD
QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q4_K_XL_SHARD
```
