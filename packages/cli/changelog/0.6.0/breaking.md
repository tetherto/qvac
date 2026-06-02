# 💥 Breaking Changes v0.6.0

## Migrate SDK TTS from onnx-tts to tts-ggml

PR: [#2244](https://github.com/tetherto/qvac/pull/2244)

**BEFORE:**
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

**AFTER:**
```typescript
await loadModel({
  modelSrc: TTS_T3_TURBO_EN_CHATTERBOX_Q8_0.src,
  modelType: "tts",
  modelConfig: {
    ttsEngine: "chatterbox",
    language: "en",
    s3genModelSrc: TTS_S3GEN_EN_CHATTERBOX.src,
  },
});
```

Plugin import path: `@qvac/sdk/onnx-tts/plugin` → `@qvac/sdk/tts-ggml/plugin` (compat alias retained temporarily).

---

## Rewrite CLI bundle/verify as thin wrappers around @qvac/sdk/commands

PR: [#2261](https://github.com/tetherto/qvac/pull/2261)

**BEFORE:**
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

**AFTER:**
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

## Delete CLI SDK wrapper layer, use static @qvac/sdk imports in serve

PR: [#2267](https://github.com/tetherto/qvac/pull/2267)

**BEFORE:**
```typescript
type ResolvedModelEntry = {
  src: string  // registry:// URL constructed by CLI
  // ...
}
```

**AFTER:**
```typescript
type ResolvedModelEntry = {
  modelSrc: string | ModelConstant  // SDK extracts registry:// URL
  // ...
}
```

---

## Rewrite serve HTTP layer on Fastify + Zod

PR: [#2306](https://github.com/tetherto/qvac/pull/2306)

**BEFORE:**
```sh
$ curl -sX POST .../v1/images/generations \
    -H 'Content-Type: application/json' \
    -d '{"model":"unknown","prompt":"hi","output_format":"jpeg"}'

400 { "error": { "code": "unsupported_output_format", ... } }
```

**AFTER:**
```sh
$ curl -sX POST .../v1/images/generations \
    -H 'Content-Type: application/json' \
    -d '{"model":"unknown","prompt":"hi","output_format":"jpeg"}'

404 { "error": { "code": "model_not_found", ... } }
```

---

