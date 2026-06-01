# 💥 Breaking Changes v0.12.0

## Widen react-native-bare-kit peer to ^0.14.0

PR: [#2116](https://github.com/tetherto/qvac/pull/2116)

**BEFORE:**
```json
// consumer package.json
{
  "dependencies": {
    "@qvac/sdk": "^0.11.0",
    "react-native-bare-kit": "0.12.3"
  }
}
```

**AFTER:**
```json
// consumer package.json
{
  "dependencies": {
    "@qvac/sdk": "^0.12.0",
    "react-native-bare-kit": "^0.14.0"
  }
}
```

---

## Migrate SDK parakeet transcription to 0.6.0 GGML

PR: [#2184](https://github.com/tetherto/qvac/pull/2184)

**BEFORE:**
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

**AFTER:**
```typescript
await loadModel({
  modelType: "parakeet",
  modelSrc: PARAKEET_TDT_0_6B_V3_Q8_0,
  modelConfig: {
    streaming: true,
    streamingChunkMs: 500,
  },
});
```

Legacy ONNX keys in `modelConfig` still parse but raise `LegacyParakeetModelDeprecatedError` with a migration message.

---

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

## Add @qvac/bare-sdk with explicit Bare plugin registration

PR: [#2292](https://github.com/tetherto/qvac/pull/2292)

**BEFORE:**
```typescript
await getRPC();
```

**AFTER:**
```typescript
import { plugins } from "@qvac/bare-sdk";
import { nmtPlugin } from "@qvac/bare-sdk/nmtcpp-translation/plugin";

plugins([nmtPlugin]);
await getRPC();
```

---

