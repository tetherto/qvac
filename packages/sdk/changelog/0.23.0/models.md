# 📦 Model Changes v0.23.0

## Added Models

```
PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0
PARAKEET_TRANSCRIBEPSY_250M_Q8_0
QWEN3_5_0_8B_MTP_Q4_K_M
QWEN3_5_2B_MTP_Q4_K_M
QWEN3_5_4B_DFLASH_Q8_0
QWEN3_5_4B_MTP_Q4_K_M
QWEN3_5_9B_MTP_Q4_K_M
QWEN3_8_27B_DFLASH2_Q8_0
QWEN3_8_FLASH_NEXT_177B_DFLASH2_Q8_0
```

## Updated Models

```
TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0
```

`TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0` now resolves a complete companion set: the Q4 LLM, Q4 flow and F16 HiFT weights, plus the shared tokenizer (`vocab.json`, `merges.txt`) and English voice. The six files total 1,057,658,782 bytes (0.985 GiB), against 2.230 GiB for the `TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0` set, which is unchanged.

## Removed Models

None. No exported model constant was removed (464 exported constants, up from 455 in 0.22.0).

---

### Related PRs

- [#5316](https://github.com/tetherto/qvac/pull/5316) - Sync model constants and name the TranscribePsy Parakeet models
- [#5175](https://github.com/tetherto/qvac/pull/5175) - Resolve the lighter CosyVoice3 companion set
