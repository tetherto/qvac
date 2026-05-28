# 💥 Breaking Changes v0.12.0

## Widen react-native-bare-kit peer to ^0.14.0

PR: [#2116](https://github.com/tetherto/qvac/pull/2116)

**BEFORE:**
**

```json
// consumer package.json
{
  "dependencies": {
    "@qvac/sdk": "^0.11.0",
    "react-native-bare-kit": "0.12.3"
  }
}
```

**

**AFTER:**
**

---

## Migrate SDK parakeet transcription to 0.6.0 GGML

PR: [#2184](https://github.com/tetherto/qvac/pull/2184)

**BEFORE:**
**

```typescript
await loadModel({
  modelType: "parakeet",
  modelConfig: {
    modelType: "tdt",
    parakeetEncoderSrc: PARAKEET_TDT_ENCODER_INT8,
    parakeetDecoderSrc: PARAKEET_TDT_DECODER_INT8,
    parakeetVocabSrc: PARAKEET_TDT_VOCAB,
    parakeetPreprocessorSrc: PARAKEET_TDT_PREPROCESSOR,
  },
});
```

**

**AFTER:**
**

---

## Migrate SDK TTS from onnx-tts to tts-ggml

PR: [#2244](https://github.com/tetherto/qvac/pull/2244)

**BEFORE:**
**

```typescript
await loadModel({
  modelSrc: TTS_MULTILINGUAL_LANGUAGE_MODEL_CHATTERBOX.src,
  modelType: "tts",
  modelConfig: {
    ttsEngine: "chatterbox",
    language: "en",
    ttsSpeechEncoderSrc: TTS_MULTILINGUAL_SPEECH_ENCODER_CHATTERBOX.src,
    ttsEmbedTokensSrc: TTS_MULTILINGUAL_EMBED_TOKENS_CHATTERBOX.src,
    ttsConditionalDecoderSrc: TTS_MULTILINGUAL_CONDITIONAL_DECODER_CHATTERBOX.src,
    ttsLanguageModelSrc: TTS_MULTILINGUAL_LANGUAGE_MODEL_CHATTERBOX.src,
  },
});
```

**

**AFTER:**
**

---

## Rewrite CLI bundle/verify as thin wrappers around @qvac/sdk/commands

PR: [#2261](https://github.com/tetherto/qvac/pull/2261)

**BEFORE:**
**

```json
{
  "devDependencies": {
    "@qvac/sdk": "^0.11.0"
  }
}
```

```typescript
// serve/core/sdk.ts — runtime floor
const MIN_SDK_VERSION = '0.11.0'
const sdkVersion = await resolveSDKVersion()
if (sdkVersion && !satisfiesMinVersion(sdkVersion, MIN_SDK_VERSION)) {
  throw new Error(`@qvac/sdk ${sdkVersion} is too old...`)
}
```

**

**AFTER:**
**

```json
{
  "dependencies": {
    "@qvac/sdk": "file:../sdk"
  },
  "scripts": {
    "preinstall": "node scripts/preinstall-build-local-sdk.cjs",
    "prepublishOnly": "node scripts/check-publish-ready.cjs"
  }
}
```

```typescript
// bundle-sdk/index.ts — delegates to SDK commands
export { bundleSdk } from '@qvac/sdk/commands'
export type { BundleSdkOptions, BundleSdkResult } from '@qvac/sdk/commands'
```

The `file:` ref + preinstall + prepublishOnly trio is temporary. At release time the publisher flips them per the gate's message (see Pre-publish checklist).

Installing `@qvac/cli` (post-release, once the knobs are flipped) always pulls in `@qvac/sdk`. SDK compatibility is enforced by the dep range, not a runtime semver check in `qvac serve openai`.

## Pre-publish checklist (do not merge into a release-* branch until these are done)

The `prepublishOnly` gate enforces all of these — it will fail `npm publish` with an inline message if anything is missed.

- [ ] Confirm `@qvac/sdk@0.12.0` (or later, with the `./commands` subpath) is published on npm
- [ ] In `packages/cli/package.json`: set `dependencies["@qvac/sdk"]` to `^0.12.0` (or wider)
- [ ] In `packages/cli/package.json`: remove `scripts.preinstall` (the `scripts/preinstall-build-local-sdk.cjs` file can stay on disk)
- [ ] Run `npm publish` — `prepublishOnly` should now pass

---

## Add @qvac/bare-sdk with explicit Bare plugin registration

PR: [#2292](https://github.com/tetherto/qvac/pull/2292)

**BEFORE:**
**

```typescript
await getRPC();
```

**

**AFTER:**
**

---

