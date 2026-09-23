# QVAC Inference v0.18.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.18.1

QVAC Inference 0.18.1 adds human-readable descriptions on every llamacpp `modelConfig` field. The CosyVoice3 companion-set cache key also changes, so the first load after upgrade uses a new companion cache folder. Load APIs are otherwise unchanged.

## New APIs

### llamacpp modelConfig descriptions

Every llamacpp completion and embedding `modelConfig` field now carries `.describe()` text (context window, batch size, and the rest of the load-time options).

## Bug Fixes

### CosyVoice3 companion cache folder

CosyVoice3 companion files still download with the LLM, as in 0.18.0. The companion-set cache key for `TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0` changed, so the first load after upgrading fills a new cache folder. Later loads reuse that folder. Speech APIs and `pace` / `instruct` rules are unchanged.
