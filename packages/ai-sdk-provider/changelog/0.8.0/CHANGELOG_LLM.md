# QVAC AI SDK Provider v0.8.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.8.0

QVAC AI SDK Provider 0.8.0 follows `@qvac/cli` 0.14.0. Diffusion VAE constants are named from the VAE type tag, and the model catalog picks up AfriSLM translation weights and Parakeet 0.6B.

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

## Model Changes

### Added

```
PARAKEET_0_6B_F16
PARAKEET_0_6B_Q4_0
PARAKEET_0_6B_Q8_0
TRANSLATEPSY_AFRISLM_0_8B_TRANSLATION_Q4_K_M
TRANSLATEPSY_AFRISLM_0_8B_TRANSLATION_Q8_0
TRANSLATEPSY_AFRISLM_2B_TRANSLATION_Q4_K_M
TRANSLATEPSY_AFRISLM_2B_TRANSLATION_Q8_0
TRANSLATEPSY_AFRISLM_4B_TRANSLATION_Q4_K_M
TRANSLATEPSY_AFRISLM_4B_TRANSLATION_Q8_0
```
