# Changelog

## [0.8.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.8.0

QVAC AI SDK Provider 0.8.0 follows `@qvac/cli` 0.14.0. Diffusion VAE constants are named from the VAE type tag. The catalog picks up AfriSLM translation weights and Parakeet 0.6B, and drops 118 exports that were in 0.7.0.

Managed mode needs `@qvac/cli@^0.14.0`. Publish after CLI 0.14.0 is on npm. External mode is unchanged.

## Breaking Changes

### Managed mode requires `@qvac/cli` 0.14

The optional CLI peer narrows to `^0.14.0`. 0.13 cannot satisfy that range.

**Before:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.13.0" } }
```

**After:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.14.0" } }
```

```bash
npm install @qvac/ai-sdk-provider ai @ai-sdk/openai-compatible @qvac/cli@^0.14.0
```

### Diffusion VAE export names

VAE constants are named from the type tag, not a numeric suffix.

**Before:**

```typescript
ABOT_WORLD_0_5B_LF_VAE
ABOT_WORLD_0_5B_LF_VAE_F16
LTX_2_3_VAE
LTX_2_3_VAE_1
```

**After:**

```typescript
ABOT_WORLD_0_5B_LF_TAEHV_VAE
ABOT_WORLD_0_5B_LF_WAN_VAE
LTX_2_3_AUDIO_VAE
LTX_2_3_VIDEO_VAE
```

### Catalog constants dropped from 0.7.0

Exported `constants.ts` names are the provider API. 0.8.0 removes 118 of them: OCR recognizer/detector aliases, `PARAKEET_TDT_*` splits, all `TTS_SUPERTONIC*` exports, and other TTS/Parakeet CTC identifiers. Code that imported those names from `@qvac/ai-sdk-provider` 0.7.0 will not compile. The full lists are under Model Changes.

## Model Changes

### Added

```
ABOT_WORLD_0_5B_LF_TAEHV_VAE
ABOT_WORLD_0_5B_LF_WAN_VAE
ABOT_WORLD_0_5B_Q8_0
DEEPSEEK_V4_304B_INST_UD_IQ2_M_SHARD
GEMMA4_2B_MULTIMODAL_Q8_0
GEMMA_3_12B_Q4_K_XL
HEALTHCARE_1_7B_MEDICAL_BF16
HEALTHCARE_1_7B_MEDICAL_IQ3_M
HEALTHCARE_1_7B_MEDICAL_IQ3_XXS
HEALTHCARE_1_7B_MEDICAL_IQ4_NL
HEALTHCARE_1_7B_MEDICAL_IQ4_XS
HEALTHCARE_1_7B_MEDICAL_Q4_K_M
HEALTHCARE_1_7B_MEDICAL_Q5_K_M
HEALTHCARE_1_7B_MEDICAL_Q8_0
HEALTHCARE_4B_MEDICAL_BF16
HEALTHCARE_4B_MEDICAL_IQ3_M
HEALTHCARE_4B_MEDICAL_IQ3_XXS
HEALTHCARE_4B_MEDICAL_IQ4_NL
HEALTHCARE_4B_MEDICAL_IQ4_XS
HEALTHCARE_4B_MEDICAL_Q4_K_M
HEALTHCARE_4B_MEDICAL_Q5_K_M
HEALTHCARE_4B_MEDICAL_Q8_0
LTX_2_3_22B_DISTILLED_EMBEDDINGS_CONNECTORS
LTX_2_3_22B_Q2_K
LTX_2_3_22B_Q5_K_M
LTX_2_3_AUDIO_VAE
LTX_2_3_VIDEO_VAE
MMPROJ_OCR_3B_MULTIMODAL_F16
MMPROJ_OCR_3B_MULTIMODAL_Q8_0
MMPROJ_QWEN3_5_2B_MULTIMODAL_Q8_0
MMPROJ_QWEN3_5_4B_MULTIMODAL_Q8_0
MMPROJ_QWEN3_8_27B_MULTIMODAL_F16
MMPROJ_QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_F16
MMPROJ_VISIONPSY_NANO_460M_MULTIMODAL_Q8_0
MMPROJ_VISIONPSY_NANO_460M_MULTIMODAL_Q8_0_1
MOE_35B_INST_IQ2_XXS
MOE_35B_INST_Q4_K_M
MOE_35B_INST_Q8_0
OCR_3B_MULTIMODAL_Q4_0
OCR_CRAFT
OCR_DOCTR
OCR_DOCTR_1
OCR_LATIN
PARAKEET_0_6B_F16
PARAKEET_0_6B_Q4_0
PARAKEET_0_6B_Q8_0
PARAKEET_CTC_0_6B_F16
PARAKEET_CTC_0_6B_Q4_0
PARAKEET_CTC_0_6B_Q8_0
PARAKEET_EOU_120M_V1_F16
PARAKEET_EOU_120M_V1_Q4_0
PARAKEET_EOU_120M_V1_Q8_0
PARAKEET_INDIC_CONFORMER_CTC_F16
PARAKEET_INDIC_CONFORMER_CTC_Q4_0
PARAKEET_INDIC_CONFORMER_CTC_Q8_0
PARAKEET_SORTFORMER_4SPK_V1_F16
PARAKEET_SORTFORMER_4SPK_V1_Q4_0
PARAKEET_SORTFORMER_4SPK_V1_Q8_0
PARAKEET_SORTFORMER_4SPK_V2_1_F16
PARAKEET_SORTFORMER_4SPK_V2_1_Q4_0
PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0
PARAKEET_TDT_0_6B_V3_F16
PARAKEET_TDT_0_6B_V3_Q4_0
PARAKEET_TDT_0_6B_V3_Q8_0
PARAKEET_UNIFIED_0_6B_F16
PARAKEET_UNIFIED_0_6B_Q4_0
PARAKEET_UNIFIED_0_6B_Q8_0
QWEN3_5_2B_MULTIMODAL_Q8_0
QWEN3_8_27B_MULTIMODAL_UD_Q4_K_XL
QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL
QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q2_K_XL_SHARD
QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q4_K_XL_SHARD
TRANSLATEPSY_AFRISLM_0_8B_TRANSLATION_Q4_K_M
TRANSLATEPSY_AFRISLM_0_8B_TRANSLATION_Q8_0
TRANSLATEPSY_AFRISLM_2B_TRANSLATION_Q4_K_M
TRANSLATEPSY_AFRISLM_2B_TRANSLATION_Q8_0
TRANSLATEPSY_AFRISLM_4B_TRANSLATION_Q4_K_M
TRANSLATEPSY_AFRISLM_4B_TRANSLATION_Q8_0
TTS_CANGJIE_ZH_CHATTERBOX
TTS_CODEC_DECODER_AUDIO8_FP16
TTS_CODEC_DECODER_AUDIO8_Q8_0
TTS_CODEC_ENCODER_AUDIO8_FP16
TTS_CODEC_ENCODER_AUDIO8_Q8_0
TTS_COSYVOICE3_CAMPPLUS_COSYVOICE_FP32
TTS_COSYVOICE3_FLOW_COSYVOICE_FP32
TTS_COSYVOICE3_HIFT_COSYVOICE_FP32
TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0
TTS_COSYVOICE3_S3TOK_COSYVOICE_FP16
TTS_COSYVOICE3_S3TOK_COSYVOICE_FP32
TTS_COSYVOICE3_S3TOK_COSYVOICE_Q8_0
TTS_COSYVOICE3_TOKENIZER_COSYVOICE
TTS_COSYVOICE3_TOKENIZER_COSYVOICE_1
TTS_COSYVOICE3_VOICE_COSYVOICE
TTS_COSYVOICE3_VOICE_COSYVOICE_1
TTS_COSYVOICE3_VOICE_COSYVOICE_2
TTS_DENOISER_LAVASR_FP16
TTS_ENHANCER_LAVASR_FP16
TTS_ENHANCER_LAVASR_FP32
TTS_INDIC_MULTILINGUAL_PARLER_TTS_FP16
TTS_INDIC_MULTILINGUAL_PARLER_TTS_FP32
TTS_INDIC_MULTILINGUAL_PARLER_TTS_Q8_0
TTS_LARGE_V1_EN_PARLER_TTS_FP16
TTS_LARGE_V1_EN_PARLER_TTS_FP32
TTS_LARGE_V1_EN_PARLER_TTS_Q8_0
TTS_LM_MULTILINGUAL_AUDIO8_FP16
TTS_LM_MULTILINGUAL_AUDIO8_Q8_0
TTS_MECAB_IPADIC_CHATTERBOX
TTS_MECAB_IPADIC_CHATTERBOX_1
TTS_MECAB_IPADIC_CHATTERBOX_2
TTS_MECAB_IPADIC_CHATTERBOX_3
TTS_MECAB_IPADIC_CHATTERBOX_4
TTS_MECAB_IPADIC_CHATTERBOX_5
TTS_MINI_V1_EN_PARLER_TTS_FP16
TTS_MINI_V1_EN_PARLER_TTS_FP32
TTS_MINI_V1_EN_PARLER_TTS_Q8_0
TTS_MULTILINGUAL_SUPERTONIC3_FP16
TTS_MULTILINGUAL_SUPERTONIC3_FP32
TTS_MULTILINGUAL_SUPERTONIC3_Q4_0
TTS_MULTILINGUAL_SUPERTONIC3_Q8_0
UMT5_XXL_ENC_Q8_0
VISIONPSY_NANO_460M_MULTIMODAL_Q4_K_M
VISIONPSY_NANO_460M_MULTIMODAL_Q4_K_M_1
VISIONPSY_NANO_460M_MULTIMODAL_Q8_0
VISIONPSY_NANO_460M_MULTIMODAL_Q8_0_1
WAN2_2_TI2V_5B_Q5_K_S
WAN_2_2_COMFYUI_REPACKAGED_VAE
```

### Removed

```
OCR_ARABIC_RECOGNIZER
OCR_BENGALI_RECOGNIZER
OCR_CRAFT_DETECTOR
OCR_CYRILLIC_RECOGNIZER
OCR_DETECTOR_DB_MOBILENET_V3_LARGE
OCR_DETECTOR_DB_RESNET50
OCR_DEVANAGARI_RECOGNIZER
OCR_JAPANESE_RECOGNIZER
OCR_KANNADA_RECOGNIZER
OCR_KOREAN_RECOGNIZER
OCR_LATIN_RECOGNIZER
OCR_LATIN_RECOGNIZER_1
OCR_RECOGNIZER_CRNN_MOBILENET_V3_SMALL
OCR_RECOGNIZER_PARSEQ
OCR_TAMIL_RECOGNIZER
OCR_TELUGU_RECOGNIZER
OCR_THAI_RECOGNIZER
OCR_ZH_SIM_RECOGNIZER
OCR_ZH_TRA_RECOGNIZER
PARAKEET_CTC_FP32
PARAKEET_CTC_TOKENIZER
PARAKEET_EOU_DECODER_FP32
PARAKEET_EOU_ENCODER_FP32
PARAKEET_EOU_TOKENIZER
PARAKEET_SORTFORMER_FP32
PARAKEET_TDT_DECODER_FP32
PARAKEET_TDT_DECODER_INT8
PARAKEET_TDT_ENCODER_FP32
PARAKEET_TDT_ENCODER_INT8
PARAKEET_TDT_F16
PARAKEET_TDT_PARAKEET_CTC_0_6B_Q8_0_Q8_0
PARAKEET_TDT_PARAKEET_EOU_120M_V1_Q4_0_Q4_0
PARAKEET_TDT_PARAKEET_EOU_120M_V1_Q8_0_Q8_0
PARAKEET_TDT_PARAKEET_TDT_0_6B_V3_Q4_0_Q4_0
PARAKEET_TDT_PARAKEET_TDT_0_6B_V3_Q8_0_Q8_0
PARAKEET_TDT_PREPROCESSOR_FP32
PARAKEET_TDT_PREPROCESSOR_INT8
PARAKEET_TDT_Q4_0
PARAKEET_TDT_Q4_0_1
PARAKEET_TDT_Q8_0
PARAKEET_TDT_Q8_0_1
PARAKEET_TDT_VOCAB
TTS_CONDITIONAL_DECODER_EN_CHATTERBOX_FP16
TTS_CONDITIONAL_DECODER_EN_CHATTERBOX_FP32
TTS_CONDITIONAL_DECODER_EN_CHATTERBOX_Q4
TTS_CONDITIONAL_DECODER_EN_CHATTERBOX_Q4F16
TTS_CONDITIONAL_DECODER_EN_CHATTERBOX_QUANTIZED
TTS_EMBED_TOKENS_EN_CHATTERBOX_FP16
TTS_EMBED_TOKENS_EN_CHATTERBOX_FP32
TTS_EMBED_TOKENS_EN_CHATTERBOX_Q4
TTS_EMBED_TOKENS_EN_CHATTERBOX_Q4F16
TTS_EMBED_TOKENS_EN_CHATTERBOX_QUANTIZED
TTS_ENHANCER_BACKBONE_LAVASR_FP32
TTS_ENHANCER_SPEC_HEAD_LAVASR_FP32
TTS_EN_ES_CHATTERBOX_Q4F16
TTS_LANGUAGE_MODEL_EN_CHATTERBOX_FP16
TTS_LANGUAGE_MODEL_EN_CHATTERBOX_FP32
TTS_LANGUAGE_MODEL_EN_CHATTERBOX_Q4
TTS_LANGUAGE_MODEL_EN_CHATTERBOX_Q4F16
TTS_LANGUAGE_MODEL_EN_CHATTERBOX_QUANTIZED
TTS_LATENT_DENOISER_SUPERTONIC_FP32
TTS_MULTILINGUAL_CONDITIONAL_DECODER_CHATTERBOX_FP32
TTS_MULTILINGUAL_EMBED_TOKENS_CHATTERBOX_FP32
TTS_MULTILINGUAL_LANGUAGE_MODEL_CHATTERBOX
TTS_MULTILINGUAL_LANGUAGE_MODEL_CHATTERBOX_FP16
TTS_MULTILINGUAL_LANGUAGE_MODEL_CHATTERBOX_FP32
TTS_MULTILINGUAL_LANGUAGE_MODEL_CHATTERBOX_Q4
TTS_MULTILINGUAL_SPEECH_ENCODER_CHATTERBOX_FP32
TTS_SPEECH_ENCODER_EN_CHATTERBOX_FP16
TTS_SPEECH_ENCODER_EN_CHATTERBOX_FP32
TTS_SPEECH_ENCODER_EN_CHATTERBOX_Q4
TTS_SPEECH_ENCODER_EN_CHATTERBOX_Q4F16
TTS_SPEECH_ENCODER_EN_CHATTERBOX_QUANTIZED
TTS_SUPERTONIC2_OFFICIAL_DURATION_PREDICTOR_SUPERTONE_FP32
TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32
TTS_SUPERTONIC2_OFFICIAL_TTS_CONFIG_SUPERTONE
TTS_SUPERTONIC2_OFFICIAL_UNICODE_INDEXER_SUPERTONE_FP32
TTS_SUPERTONIC2_OFFICIAL_VECTOR_ESTIMATOR_SUPERTONE_FP32
TTS_SUPERTONIC2_OFFICIAL_VOCODER_SUPERTONE_FP32
TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE
TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE_1
TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE_2
TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE_3
TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE_4
TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE_5
TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE_6
TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE_7
TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE_8
TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE_9
TTS_SUPERTONIC_OFFICIAL_DURATION_PREDICTOR_SUPERTONE_FP32
TTS_SUPERTONIC_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32
TTS_SUPERTONIC_OFFICIAL_TTS_CONFIG_SUPERTONE
TTS_SUPERTONIC_OFFICIAL_UNICODE_INDEXER_SUPERTONE
TTS_SUPERTONIC_OFFICIAL_VECTOR_ESTIMATOR_SUPERTONE_FP32
TTS_SUPERTONIC_OFFICIAL_VOICE_STYLE_SUPERTONE
TTS_SUPERTONIC_OFFICIAL_VOICE_STYLE_SUPERTONE_1
TTS_SUPERTONIC_OFFICIAL_VOICE_STYLE_SUPERTONE_2
TTS_SUPERTONIC_OFFICIAL_VOICE_STYLE_SUPERTONE_3
TTS_SUPERTONIC_OFFICIAL_VOICE_STYLE_SUPERTONE_4
TTS_SUPERTONIC_OFFICIAL_VOICE_STYLE_SUPERTONE_5
TTS_SUPERTONIC_OFFICIAL_VOICE_STYLE_SUPERTONE_6
TTS_SUPERTONIC_OFFICIAL_VOICE_STYLE_SUPERTONE_7
TTS_SUPERTONIC_OFFICIAL_VOICE_STYLE_SUPERTONE_8
TTS_SUPERTONIC_OFFICIAL_VOICE_STYLE_SUPERTONE_9
TTS_TEXT_ENCODER_SUPERTONIC_FP32
TTS_TOKENIZER_EN_CHATTERBOX
TTS_TOKENIZER_SUPERTONIC
TTS_VOICE_DECODER_SUPERTONIC_FP32
TTS_VOICE_STYLE_SUPERTONIC
TTS_VOICE_STYLE_SUPERTONIC_1
TTS_VOICE_STYLE_SUPERTONIC_2
TTS_VOICE_STYLE_SUPERTONIC_3
TTS_VOICE_STYLE_SUPERTONIC_4
TTS_VOICE_STYLE_SUPERTONIC_5
TTS_VOICE_STYLE_SUPERTONIC_6
TTS_VOICE_STYLE_SUPERTONIC_7
TTS_VOICE_STYLE_SUPERTONIC_8
TTS_VOICE_STYLE_SUPERTONIC_9
```

## [0.7.0]

Release Date: 2026-09-04

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.7.0

Managed mode moves onto the CLI 0.13 launch interface. This release also carries the streamed file-upload fix from 0.6.2, so upgrading straight from 0.6.1 picks up both.

## Breaking Changes

### Managed mode requires `@qvac/cli` 0.13

`@qvac/cli` 0.13 mounts the serve surfaces as extensions and retires the `qvac serve openai` subcommand. Managed mode now launches `qvac serve --openai --no-default`, which the `0.10`–`0.12` lines cannot parse, so the optional CLI peer narrows to `^0.13.0`.

**Before:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.10.0 || ^0.11.0 || ^0.12.0" } }
```

**After:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.13.0" } }
```

Install managed mode with:

```bash
npm install @qvac/ai-sdk-provider ai @ai-sdk/openai-compatible @qvac/cli@^0.13.0
```

External mode is unaffected — it never spawns a CLI, so it works against any serve that speaks the OpenAI-compatible surface.

`--no-default` is part of the launch command on purpose: bare `--openai` would also mount the QVAC surface on the port, while the retired subcommand exposed `/v1/*` alone. Keeping the pair preserves the previous behaviour and keeps the extra surface off a port the provider authenticates and owns.

## Fixes

### Streamed file uploads

`@ai-sdk/provider` 4.0.10 added a third `uploadFile` data variant, `{ type: 'stream', stream }`, and the AI SDK hands it straight to the provider whenever a caller uploads from a stream. Version 0.6.1 did not recognise it and threw a `TypeError`. `uploadFile` now drains the stream and posts the bytes.

The stream is drained rather than forwarded as a streaming request body on purpose: `POST /v1/files` buffers the whole upload into serve's in-memory ephemeral store, so a streaming request would only require `duplex: 'half'` support from the caller's `fetch` without anything streaming on the other end.

An unrecognised data variant now rejects with `UnsupportedFunctionalityError`, naming the variant, so a future addition upstream fails the one unsupported call with a clear error.

### Upload calls honour `abortSignal` and `headers`

Both options are part of the files interface and the AI SDK already passed them, but the QVAC adapter dropped them:

- `abortSignal` is now forwarded, so an in-flight upload can be cancelled.
- Per-call `headers` are now merged over the configured provider headers, matching the behaviour of every other adapter in this package. The configured `Content-Type` is still stripped so `fetch` picks the multipart boundary itself.

Callers already passing `abortSignal` will see uploads actually abort where they previously ran to completion.

## [0.6.2]

Release Date: 2026-09-04

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.6.2

## Streamed File Uploads Work Again

`@ai-sdk/provider` 4.0.10 added a third `uploadFile` data variant, `{ type: 'stream', stream }`, and the AI SDK hands it straight to the provider whenever a caller uploads from a stream. Version 0.6.1 did not recognise it and threw a `TypeError` instead of uploading. `uploadFile` now drains the stream and posts the bytes.

The stream is drained rather than forwarded as a streaming request body on purpose: `POST /v1/files` buffers the whole upload into serve's in-memory ephemeral store, so a streaming request would only require `duplex: 'half'` support from the caller's `fetch` without anything streaming on the other end.

An unrecognised data variant now rejects with `UnsupportedFunctionalityError`, naming the variant, so a future addition upstream fails the one unsupported call with a clear error.

## Upload Calls Honour `abortSignal` and `headers`

Both options are part of the files interface and the AI SDK already passed them, but the QVAC adapter dropped them:

- `abortSignal` is now forwarded, so an in-flight upload can be cancelled.
- Per-call `headers` are now merged over the configured provider headers, matching the behaviour of every other adapter in this package. The configured `Content-Type` is still stripped so `fetch` picks the multipart boundary itself.

Callers already passing `abortSignal` will see uploads actually abort where they previously ran to completion.

No provider API surface changed in this patch release.

## [0.6.1]

Release Date: 2026-08-21

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.6.1

## Managed Mode Supports CLI 0.12

`@qvac/ai-sdk-provider` now accepts the `@qvac/cli` `0.12.x` line alongside `0.10.x` and `0.11.x` as its optional managed-mode CLI peer. This lets strict package managers install the provider next to CLI 0.12, which brings in the `@qvac/sdk` 0.18.x runtime and the serve model catalog.

The older lines remain accepted, so existing installs are unaffected. No provider API changes are included in this patch release.

## [0.6.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.6.0

Managed mode now authenticates. The provider generates a random API key for every serve it starts, enforces it on outgoing requests, and keeps it out of the process command line. Callers no longer supply a managed key — they read the live one from the provider when they need it.

## Breaking Changes

### Managed mode owns the API key

`QvacManagedOptions.apiKey` is gone. Passing a key was misleading: the previous `qvac serve` did not validate it, so the option gave the appearance of authentication without any. Managed mode now generates a cryptographically random key per serve fleet, stores it in the private managed registry record, and reuses that record's key when attaching to an existing fleet.

Because the provider owns the credential, a caller-supplied `authorization` header on a managed provider is replaced with the resolved managed key. Custom `fetch` wrappers still run, but they receive requests that are already authorized — treat the `Authorization` header they see as secret material and keep it out of logs.

**Before:**

```ts
const qvac = await createQvac({
  mode: 'managed',
  models: ['QWEN3_8B_INST_Q4_K_M'],
  apiKey: 'local-key'
})
```

**After:**

```ts
const qvac = await createQvac({
  mode: 'managed',
  models: ['QWEN3_8B_INST_Q4_K_M']
})
```

### External mode keys are now enforced by serve

In external mode the provider's default `apiKey` is still the literal string `'qvac'`, but `qvac serve` no longer ignores it. If the server was started with `--api-key` or `--api-key-file`, the value passed to `createQvac` must match it, or requests are rejected with a 401.

## New APIs

### `provider.apiKey` exposes the live managed credential

Trusted in-process adapters that need to reach the managed serve outside the provider's own `fetch` can read the key it is currently using:

```ts
await using qvac = await createQvac({ mode: 'managed', models: ['QWEN3_8B_INST_Q4_K_M'] })

// Read it fresh per request: crash recovery respawns the serve with a new key.
const res = await fetch(`${qvac.baseURL}/models`, {
  headers: { authorization: `Bearer ${qvac.apiKey}` }
})
```

The property is deliberately non-enumerable, so `{ ...provider }`, `Object.keys(provider)`, and casual object dumps never carry it. Never log it or hand it to an untrusted process.

## Security

### The key never appears in a process argument list

Neither the detached runner nor the `qvac serve` process it starts receives the key through argv. Both read it from a one-shot owner-only (`0600`) file, so it cannot be recovered from `ps` or `/proc/<pid>/cmdline`, which on Linux is readable by every local account.

Passing the key on the serve command line now only happens against a CLI too old for `--api-key-file`, which the provider detects and falls back to, or behind a `serveBinPath` override, whose version cannot be determined. Install `@qvac/cli` 0.11.0 or newer to keep the key out of the process list in every case.

### Serves from before managed authentication are reaped

The registry sweep that runs at the start of every `createQvac` now also cleans up after older provider versions. A record carrying no key belongs to a serve that is listening without authentication, so the sweep probes it anonymously and shuts it down rather than leaving it running. Abandoned one-shot runner handoff files are removed once no runner could still be waiting to read one.

## Compatibility

The `@qvac/cli` peer range widens to `^0.10.0 || ^0.11.0`. Both work; 0.11.0 is what enables the file-based credential described above.

## [0.5.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.5.0

This release aligns managed mode with `@qvac/cli` 0.10 / `@qvac/sdk` 0.17 and drops the retired ONNX OCR plugin path from provider-facing guidance in favor of ggml OCR.

## Breaking Changes

### Managed mode requires CLI 0.10

The optional `@qvac/cli` peer for managed mode is now `^0.10.0`. Older CLI minors are no longer accepted, so managed installs resolve the CLI 0.10 / SDK 0.17 runtime.

**Before:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.9.0" } }
```

**After:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.10.0" } }
```

### OCR plugin path

Configs that still reference the retired ONNX OCR plugin must switch to ggml OCR.

**Before:**

```json
{ "plugins": ["@qvac/sdk/onnx-ocr/plugin"] }
```

**After:**

```json
{ "plugins": ["@qvac/sdk/ggml-ocr/plugin"] }
```

## Dependency Alignment

Promote this release after `@qvac/cli` 0.10.0 is on npm.

## [0.4.0]

Release Date: 2026-07-27

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.4.0

This release migrates `@qvac/ai-sdk-provider` to AI SDK 7, adds native files / speech / transcription contracts on top of the OpenAI-compatible transport, and requires `@qvac/cli` 0.9 for managed mode so callers pick up the latest serve fixes through the published package graph.

## Breaking Changes

### AI SDK 7 and Node 22

The provider now depends on AI SDK 7 (`ai@^7`) and `@ai-sdk/openai-compatible@^3`. Node 20 is no longer supported; runtimes must be Node 22 or newer.

**Before:**

```bash
npm install @qvac/ai-sdk-provider ai@^6 @ai-sdk/openai-compatible@^2
```

**After:**

```bash
npm install @qvac/ai-sdk-provider ai@^7 @ai-sdk/openai-compatible@^3
```

Language, embedding, and image calls keep the same OpenAI-compatible wire shape. Custom middleware and direct model integrations must use the AI SDK v4 provider interfaces that ship with these versions.

### Managed Mode Requires CLI 0.9

The optional `@qvac/cli` peer for managed mode is now `^0.9.0` only. Older CLI minors (`0.6`–`0.8`) are no longer accepted, so managed installs resolve the CLI 0.9 / SDK 0.16 runtime that includes the latest serve fixes.

**Before:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.6.0 || ^0.7.0 || ^0.8.0" } }
```

**After:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.9.0" } }
```

Install managed mode with:

```bash
npm install @qvac/ai-sdk-provider ai @ai-sdk/openai-compatible @qvac/cli@^0.9.0
```

## Native Files, Speech, and Transcription

External and managed providers now expose QVAC-native `files()`, `transcriptionModel()`, and `speechModel()` contracts composed over the existing OpenAI-compatible fallback. Local `uploadFile` references resolve through the running `qvac serve` process instead of becoming cloud URLs.

```ts
import { createQvac } from '@qvac/ai-sdk-provider'
import { generateText, uploadFile } from 'ai'
import { readFileSync } from 'node:fs'

const qvac = createQvac({ baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'qvac' })

const file = await uploadFile({
  provider: qvac,
  file: readFileSync('./note.txt'),
  mediaType: 'text/plain'
})

const { text } = await generateText({
  model: qvac('qwen3.5-9b'),
  messages: [
    {
      role: 'user',
      content: [
        { type: 'file', data: file },
        { type: 'text', text: 'Summarize this.' }
      ]
    }
  ]
})
```

## Model Constant Refresh

The mirrored model constant surface picks up the latest TTS-ggml / Parler TTS exports and drops retired Parakeet and older Chatterbox / Supertonic constants that the SDK registry no longer publishes. See `models.md` for the full added and removed lists.

## Compatibility

`createQvac()` external mode remains the default synchronous path. Managed mode (`mode: 'managed'`) keeps the same options shape (`models`, `reuse`, `closeOnParentExit`, timeouts) and still returns a `ManagedQvacProvider` with `baseURL` / `port` / `pid` / `close()`.

## [0.3.0]

Release Date: 2026-07-03

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.3.0

## Larger Agent Models in the Catalog

The friendly model catalog now includes larger models aimed at agentic and coding workloads, alongside the existing families:

- `gpt-oss-20b` → `GPT_OSS_20B_INST_Q4_K_M`
- `gemma4-31b` → `GEMMA4_31B_MULTIMODAL_Q4_K_M`
- `qwen3.6-27b` → `QWEN3_6_27B_MULTIMODAL_Q4_K_XL`
- `qwen3.6-35b-a3b` → `QWEN3_6_35B_A3B_MULTIMODAL_Q4_K_M`

These ids resolve to model constants already shipped in `@qvac/sdk` 0.14.x, so `qvac serve` can load them directly. Callers can now select these larger models by friendly id in both catalog UIs and generated serve configs.

## Managed Mode Supports CLI 0.8

`@qvac/ai-sdk-provider` now accepts the `@qvac/cli` `0.8.x` line as its optional managed-mode CLI peer, in addition to `0.6.x` and `0.7.x`. Installing the provider alongside CLI 0.8 resolves to the `@qvac/sdk` 0.14.x runtime, which is where the larger catalog models are available.

## Compatibility

External mode is unchanged and remains the default synchronous path. There are no breaking API changes in this release; the catalog additions are additive and existing model ids continue to resolve as before.

## [0.2.2]

Release Date: 2026-06-16

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.2.2

## Managed Mode Supports CLI 0.7

`@qvac/ai-sdk-provider` now accepts both the `@qvac/cli` `0.6.x` and `0.7.x` lines as its optional managed-mode CLI peer. This lets strict package managers install the provider alongside CLI 0.7, which resolves to the newer `@qvac/sdk` 0.13.x runtime.

No provider API changes are included in this patch release.

## [0.2.1]

Release Date: 2026-06-15

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.2.1

## Managed Mode Compatibility

`@qvac/ai-sdk-provider` now declares the published `@qvac/cli` `0.6.x` line as its optional managed-mode CLI peer. This keeps strict package managers from rejecting installs where applications use managed mode with the current QVAC CLI release.

No provider API changes are included in this patch release.

## [0.2.0]

Release Date: 2026-06-10

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.2.0

## Managed Mode

`@qvac/ai-sdk-provider` can now run `qvac serve` for local applications instead of requiring users to start a separate server first. Calling `createQvac({ mode: 'managed', models })` creates an ephemeral serve config, starts the QVAC CLI on a free local port, waits for the OpenAI-compatible endpoint to become healthy, and returns a normal AI SDK provider pointed at that serve.

Managed serves are shared by default. If another process requests the same model fleet and config, it attaches to the existing warm serve instead of spawning another process and loading the same model into memory again. A detached runner owns the serve and reaps it after the last consumer exits and the idle timeout expires.

## Lifecycle Improvements

The managed serve lifecycle is designed for coding agents and other local tools that may start, restart, or crash frequently:

- `close()` and `await using` detach the current consumer without killing a serve that another session is still using.
- `closeOnParentExit` lets plugin hosts clean up when their parent tool exits.
- Process-group shutdown ensures the serve and its inference worker are terminated together.
- Connection-refused recovery re-resolves a serve and retries once when the backing process has disappeared before a request starts.

## Friendly Model Catalog

The package now exposes a small public catalog that maps models.dev-style ids, such as `qwen3.5-9b`, to the SDK constants that `qvac serve` loads. This keeps model ids consistent across catalog UIs, provider configuration, and generated serve configs while preserving support for raw SDK constants.

The generated catalog was refreshed against the live QVAC registry for this release, adding 17 OpenAI-compatible model constants with no removals.

## Compatibility

External mode is unchanged and remains the default synchronous path. Managed mode is loaded only when `mode: 'managed'` is used and requires `@qvac/cli` as an optional peer dependency.

## [0.1.0]

Release Date: 2026-05-27

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.1.0

The first public release of `@qvac/ai-sdk-provider` — the [Vercel AI SDK](https://ai-sdk.dev) provider for the QVAC local AI runtime. Point it at a running `qvac serve openai` HTTP server and you get the full AI SDK surface (`streamText`, `generateText`, `embed`, `transcribe`, `generateImage`, …) backed by on-device chat, embeddings, transcription, translation, speech, OCR, and image-generation models. The package ships a typed catalog of every model in the QVAC P2P registry that has an OpenAI-shaped endpoint, so callers can introspect models without an HTTP round-trip to `/v1/models`.

---

## Introducing `@qvac/ai-sdk-provider`

`@qvac/ai-sdk-provider` is a thin, branded wrapper around [`@ai-sdk/openai-compatible`](https://www.npmjs.com/package/@ai-sdk/openai-compatible) configured for the QVAC OpenAI-compatible endpoint. The provider gives QVAC a first-class identity in the AI SDK ecosystem — a dedicated `createQvac()` factory, a default `qvac` instance, typed model metadata, and a discoverable handle for the [`models.dev`](https://models.dev) catalog so QVAC shows up in `/connect` for OpenCode and other catalog consumers.

`ai@^6.0` and `@ai-sdk/openai-compatible@^2.0` are **peer dependencies** — install them alongside:

```bash
bun add @qvac/ai-sdk-provider ai @ai-sdk/openai-compatible
# or: npm install @qvac/ai-sdk-provider ai @ai-sdk/openai-compatible
```

Run `qvac serve openai` ([`@qvac/cli`](https://www.npmjs.com/package/@qvac/cli)) with at least one preloaded chat model, then wire the provider in:

```ts
import { createQvac } from '@qvac/ai-sdk-provider'
import { streamText } from 'ai'

const qvac = createQvac({
  baseURL: 'http://127.0.0.1:11434/v1', // match your `qvac serve` port
  apiKey: 'qvac' // anything non-empty; serve does not validate
})

const { textStream } = streamText({
  model: qvac('qwen3-600m'),
  prompt: 'Write a haiku about local-first AI.'
})

for await (const chunk of textStream) {
  process.stdout.write(chunk)
}
```

The provider exposes the same surface as any AI SDK provider — `qvac('alias')` for the default chat model, plus explicit `qvac.chatModel(...)`, `qvac.completionModel(...)`, `qvac.textEmbeddingModel(...)`, and `qvac.imageModel(...)` accessors. A pre-built default instance (`qvac`) is also exported for quick scripts; explicit `createQvac({ baseURL })` is recommended until the default `baseURL` is finalized (see _Known limitations_ below).

---

## Typed Model Catalog (`@qvac/ai-sdk-provider/models`)

Every model in the QVAC P2P registry that has an OpenAI-shaped endpoint is exported as a strongly-typed constant. The catalog is code-generated from the live production registry at build time and committed to the package, so consumers can introspect models with zero HTTP traffic:

```ts
import { models, allModels } from '@qvac/ai-sdk-provider'

models.QWEN3_4B_INST_Q4_K_M.endpointCategory // 'chat'      (compile-time known)
models.WHISPER_EN_TINY_Q8_0.endpointCategory // 'transcription'

for (const m of allModels) {
  console.log(`${m.name} (${m.endpointCategory}, ${m.expectedSize} bytes)`)
}
```

Each constant satisfies `ModelConstant<TEndpoint>` where `TEndpoint` is one of:

```ts
type EndpointCategory =
  | 'chat'
  | 'embedding'
  | 'transcription'
  | 'audio-translation'
  | 'translation'
  | 'speech'
  | 'ocr'
  | 'image'
```

Catalog scope is intentionally narrower than the underlying QVAC registry: codegen filters to engines / addons that have an OpenAI-shaped surface today (`llamacpp-completion`, `llamacpp-embedding`, `whispercpp-transcription`, `parakeet-transcription`, `nmtcpp-translation`, `onnx-tts`, `tts-ggml`, `onnx-ocr`, `sdcpp-generation`). Registry entries for VAD, classification, VLA, and other engines without a matching OpenAI endpoint are dropped at codegen time — they would have no usable surface in an AI SDK provider.

Regenerate the catalog against the live registry with:

```bash
npm run update-models     # writes src/models/constants.ts + models/history/<sha>.txt
npm run check-models      # CI-friendly drift check; fails if regen would change anything
```

`check-models` runs as part of the package's CI pipeline so the committed catalog cannot drift from the registry without a deliberate regen commit.

---

## Logo Asset

The package ships a single `assets/logo.svg` (drawn in `currentColor` so it themes against light, dark, and brand backgrounds without a re-export per theme). It's available to consumers via the subpath export:

```ts
// docs / catalog usage
import logo from '@qvac/ai-sdk-provider/assets/logo.svg'
```

Used by `models.dev` and downstream docs / connector catalogs to render the QVAC entry.

---

## Known Limitations

This is a `v1` release; two surfaces are deliberately scoped down and will move in follow-up minors:

- **Default `baseURL` is a placeholder.** `qvac serve` today defaults to port `11434`, which collides with Ollama. The CLI will move to a non-conflicting port in a future release and this package's default will move with it. **Set `baseURL` explicitly** to your `qvac serve` port — the default is `http://127.0.0.1:11435/v1` as a placeholder and will fail to connect to the unmodified CLI until the port-change ticket lands.
- **External mode only.** The provider wraps a `qvac serve openai` endpoint that you run yourself. A future `0.2.0` will add `mode: 'managed'` for auto-spawn / supervise of the serve process from inside the provider, removing the manual CLI step for the common single-machine case.

Beyond these, the provider is the canonical entry point for using QVAC from any application that already speaks the Vercel AI SDK.
