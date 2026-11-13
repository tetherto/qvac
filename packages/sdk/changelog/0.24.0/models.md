# 📦 Model Changes v0.24.0

## Added Models

```
AUDIOGEN_ACESTEP_V15_TURBO_BF16
AUDIOGEN_ACESTEP_V15_TURBO_F16
EMBEDDINGGEMMA_2_Q8_0
GLM_5_3_FLASH_320B_A18B_MULTIMODAL_Q4_K_M_SHARD
MEGALOC_F16
MEGALOC_MIXED
MMPROJ_EMBEDDINGGEMMA_2_Q8_0
MMPROJ_GLM_5_3_FLASH_320B_A18B_MULTIMODAL_BF16
MOBILENETV3_3CLASS_V3_FP16
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
- [#5498](https://github.com/tetherto/qvac/pull/5498) - Add MegaLoc registry models
- [#5634](https://github.com/tetherto/qvac/pull/5634) - Point EmbeddingGemma-300M constants at the Dense-layer models
- [#5683](https://github.com/tetherto/qvac/pull/5683) - Add TranscribePsy-250M-EU support to the SDK
