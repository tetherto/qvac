# 📦 Model Changes v0.12.0

## Added Models

```
EMBEDDINGGEMMA_2_Q8_0
GLM_5_3_FLASH_320B_A18B_MULTIMODAL_Q4_K_M_SHARD
MMPROJ_EMBEDDINGGEMMA_2_Q8_0
MMPROJ_GLM_5_3_FLASH_320B_A18B_MULTIMODAL_BF16
PARAKEET_MOSAIC_COMPACT_Q4_0_Q8_0_Q3_K_IQ3_S
PARAKEET_MOSAIC_Q4_0_Q8_0
PARAKEET_NEMOTRON_3_DIARIZATION_Q4_K
PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0
TTS_LM_MULTILINGUAL_AUDIO8_Q4_0
```

## Updated Models

```
EMBEDDINGGEMMA_300M_BF16
EMBEDDINGGEMMA_300M_Q4_0
EMBEDDINGGEMMA_300M_Q8_0
```

## Removed Models

```
EMBEDDINGGEMMA_300M_F32
```

---

### Related PRs

- [#5431](https://github.com/tetherto/qvac/pull/5431) - Refresh model constants from registry
- [#5634](https://github.com/tetherto/qvac/pull/5634) - Point EmbeddingGemma-300M constants at the Dense-layer models
- [#5683](https://github.com/tetherto/qvac/pull/5683) - Add TranscribePsy-250M-EU support to the SDK
- [#5739](https://github.com/tetherto/qvac/pull/5739) - Add GLM 5.3 Flash constants to the AI SDK provider
