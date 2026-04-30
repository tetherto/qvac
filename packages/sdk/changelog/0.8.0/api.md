# 🔌 API Changes v0.8.0

## Add Parakeet Transcription Plugin

PR: [#366](https://github.com/tetherto/qvac/pull/366)

A new `parakeet-transcription` plugin brings NVIDIA Parakeet ONNX speech-to-text as an alternative to Whisper.cpp. Parakeet uses four model files (encoder, encoder-data, decoder, vocab, preprocessor) resolved via the QVAC Registry.

```typescript
import {
  PARAKEET_TDT_ENCODER_FP32,
  PARAKEET_TDT_ENCODER_DATA_FP32,
  PARAKEET_TDT_DECODER_FP32,
  PARAKEET_TDT_VOCAB,
  PARAKEET_TDT_PREPROCESSOR_FP32,
} from "@qvac/sdk";

const modelId = await loadModel({
  modelType: "parakeet",
  modelSrc: PARAKEET_TDT_ENCODER_FP32,
  modelConfig: {
    parakeetEncoderSrc: PARAKEET_TDT_ENCODER_FP32,
    parakeetEncoderDataSrc: PARAKEET_TDT_ENCODER_DATA_FP32,
    parakeetDecoderSrc: PARAKEET_TDT_DECODER_FP32,
    parakeetVocabSrc: PARAKEET_TDT_VOCAB,
    parakeetPreprocessorSrc: PARAKEET_TDT_PREPROCESSOR_FP32,
  },
});

const stream = transcribeStream({ modelId, audioInput: "./audio.mp3" });
for await (const chunk of stream) {
  process.stdout.write(chunk);
}
```

Supports MP3, WAV, OGG, M4A, RAW, and FLAC audio formats.

---

## Add Bergamot pivot translation support

PR: [#834](https://github.com/tetherto/qvac/pull/834)

```typescript
  // New pivot translation API usage
  await loadModel({
    modelSrc: BERGAMOT_ES_EN,  // Primary: Spanish → English
    modelType: "nmt",
    modelConfig: {
      engine: "Bergamot",
      from: "es",
      to: "it",  // Final target language
      // New pivotModel configuration
      pivotModel: {
        modelSrc: BERGAMOT_EN_IT,  // Pivot: English → Italian
        beamsize: 4,
        temperature: 0.3,
        topk: 100,
        normalize: 1,
        lengthpenalty: 1.2,
      }
    }
  });
  ```

---

## SDK Profiler

PR: [#836](https://github.com/tetherto/qvac/pull/836)

```typescript
import { profiler } from "@qvac/sdk";

// Runtime control
profiler.enable({
  mode: "verbose", // "summary" | "verbose"
  includeServerBreakdown: true,
});

// ... run operations ...

console.log(profiler.exportSummary());
console.log(profiler.exportTable());
console.log(profiler.exportJSON({ includeRecentEvents: true }));

profiler.disable();

// Per-call control
await embed(
  { modelId: "m1", text: "hello" },
  { profiling: { enabled: true } },
);

await completion(
  { modelId: "m1", history: [{ role: "user", content: "Hello" }] },
  { profiling: { enabled: false } },
);

// Additional client APIs now accept RPC options passthrough
await invokePlugin({ modelId: "m1", handler: "h", params: {} }, { profiling: { enabled: true } });
await ragSearch({ workspace: "default", query: "q" }, { profiling: { enabled: true } });
await transcribe({ modelId: "m1", audioChunk: "..." }, { profiling: { enabled: true } });
await translate({ modelId: "m1", text: "hello" }, { profiling: { enabled: true } });
```

---

