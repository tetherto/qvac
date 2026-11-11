# QVAC AI SDK Provider v0.11.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.11.0

QVAC AI SDK Provider 0.11.0 follows `@qvac/cli` 0.18.0 and adds nine model constants: the TranscribePsy Parakeet transcription models and new Qwen3.5 and Qwen3.8 chat models. Provider behavior is unchanged, and no constant is removed.

## Dependency Alignment

The optional `@qvac/cli` peer is now `^0.18.0`. A 0.x caret range does not cross a minor, so `^0.17.0` would not accept CLI 0.18. External mode is unchanged.

## Model Changes

### Added

Transcription:

- `PARAKEET_TRANSCRIBEPSY_250M_Q8_0`
- `PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0`

Chat:

- `QWEN3_5_0_8B_MTP_Q4_K_M`
- `QWEN3_5_2B_MTP_Q4_K_M`
- `QWEN3_5_4B_MTP_Q4_K_M`
- `QWEN3_5_9B_MTP_Q4_K_M`
- `QWEN3_5_4B_DFLASH_Q8_0`
- `QWEN3_8_27B_DFLASH2_Q8_0`
- `QWEN3_8_FLASH_NEXT_177B_DFLASH2_Q8_0`
