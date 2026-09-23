# 💥 Breaking Changes v0.8.0

## Derive diffusion VAE export names from the type tag

PR: [#4234](https://github.com/tetherto/qvac/pull/4234)

**BEFORE:**

```typescript
ABOT_WORLD_0_5B_LF_VAE
ABOT_WORLD_0_5B_LF_VAE_F16
LTX_2_3_VAE
LTX_2_3_VAE_1
```

**AFTER:**

```typescript
ABOT_WORLD_0_5B_LF_TAEHV_VAE
ABOT_WORLD_0_5B_LF_WAN_VAE
LTX_2_3_AUDIO_VAE
LTX_2_3_VIDEO_VAE
```

---

## Catalog exports removed in 0.8.0

PR: [#4384](https://github.com/tetherto/qvac/pull/4384)

`src/models/constants.ts` is the provider public API. Against 0.7.0 this cut removes 118 exported constants (OCR recognizer/detector aliases, `PARAKEET_TDT_*` splits, every `TTS_SUPERTONIC*` export, and other TTS/Parakeet CTC names). Importing those identifiers from `@qvac/ai-sdk-provider` fails. The full added/removed lists are in [model changes](./models.md).
