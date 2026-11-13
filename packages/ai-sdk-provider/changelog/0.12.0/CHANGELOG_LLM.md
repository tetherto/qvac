# QVAC AI SDK Provider v0.12.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.12.0

QVAC AI SDK Provider 0.12.0 follows `@qvac/cli` 0.19.0, whose `qvac serve` now listens on the provider's default port. It adds nine model constants, removes one, and repoints the EmbeddingGemma-300M constants at new model files.

## Breaking Changes

### EmbeddingGemma-300M constants point at the Dense-layer models

`EMBEDDINGGEMMA_300M_F32` is removed. `EMBEDDINGGEMMA_300M_BF16`, `EMBEDDINGGEMMA_300M_Q4_0` and `EMBEDDINGGEMMA_300M_Q8_0` keep their names but now resolve to the Dense-layer model files. Embeddings from the updated constants differ from those of the old files, so re-ingest any RAG workspace that was built with an earlier EmbeddingGemma-300M constant.

**Before:**

```typescript
import { models } from '@qvac/ai-sdk-provider'

models.EMBEDDINGGEMMA_300M_F32
```

**After:**

```typescript
import { models } from '@qvac/ai-sdk-provider'

models.EMBEDDINGGEMMA_300M_BF16
```

### Requires `@qvac/cli` 0.19, which serves on port 11435

The optional `@qvac/cli` peer is now `^0.19.0`. A 0.x caret range does not cross a minor, so an install pinned to CLI 0.18 no longer satisfies it.

The provider's default `baseURL` is unchanged at `http://127.0.0.1:11435/v1`. What changes is that `qvac serve` in CLI 0.19 listens on 11435 by default, so the two agree without configuration. If you passed `baseURL` or `--port` to line them up, you can drop it.

**Before:**

```typescript
// CLI 0.18: qvac serve --openai listens on 11434
const qvac = createQvac({ baseURL: 'http://127.0.0.1:11434/v1' })
```

**After:**

```typescript
// CLI 0.19: qvac serve --openai listens on 11435, the provider's default
const qvac = createQvac()
```

Against a server on another port, including `@qvac/cli` 0.18 or earlier on 11434, keep passing `baseURL`.

## Bug Fixes

Trailing slashes on `baseURL` are trimmed in linear time, so a very long run of slashes no longer slows provider creation.

## Model Changes

### Added

- `EMBEDDINGGEMMA_2_Q8_0`
- `MMPROJ_EMBEDDINGGEMMA_2_Q8_0`
- `GLM_5_3_FLASH_320B_A18B_MULTIMODAL_Q4_K_M_SHARD`
- `MMPROJ_GLM_5_3_FLASH_320B_A18B_MULTIMODAL_BF16`
- `PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0`
- `PARAKEET_MOSAIC_Q4_0_Q8_0`
- `PARAKEET_MOSAIC_COMPACT_Q4_0_Q8_0_Q3_K_IQ3_S`
- `PARAKEET_NEMOTRON_3_DIARIZATION_Q4_K`
- `TTS_LM_MULTILINGUAL_AUDIO8_Q4_0`

### Updated

- `EMBEDDINGGEMMA_300M_BF16`, `EMBEDDINGGEMMA_300M_Q4_0` and `EMBEDDINGGEMMA_300M_Q8_0` now resolve to the Dense-layer model files.

### Removed

- `EMBEDDINGGEMMA_300M_F32`. Use `EMBEDDINGGEMMA_300M_BF16`.
