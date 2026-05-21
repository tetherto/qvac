// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  registerModel,
  unregisterModel,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import { textToSpeech } from "@/server/bare/plugins/ggml-tts/ops/text-to-speech";
import { ModelType } from "@/schemas";
import type { TtsRequest } from "@/schemas";

// Runtime-path coverage for the @qvac/tts-onnx → @qvac/tts-ggml swap on
// PR #1992. Loading a real native model in CI is the right level of coverage
// (see `packages/tts-ggml/test/integration/`), but the SDK's slice of the
// migration — the `textToSpeech` op driving an addon-shaped model and
// emitting Int16 PCM frames into the wire schema — is testable in-process
// against a fake `TTSGgml`-shaped model. The test fixtures below mimic both
// engines' contract:
//   • `run({ input, inputType })` returns a `TtsResponse`-shaped object whose
//     `iterate()` yields one or more `{ outputArray }` chunks of Int16 PCM.
//   • `runStream(text, { locale?, maxChunkScalars? })` returns the same shape
//     with sentence-granularity chunks.
//
// Every assertion exercises the real `textToSpeech` generator from the
// ggml-tts plugin — collecting yields, stats, and final PCM concatenation —
// so the SDK side of the swap fails loud here if the per-engine wiring
// regresses.

interface FakeTtsModel {
  run: (input: { input: string; inputType?: string }) => Promise<{
    iterate: () => AsyncIterable<{ outputArray: ArrayLike<number> }>;
    stats?: { audioDurationMs?: number; totalSamples?: number };
  }>;
  runStream: (
    text: string,
    options?: { locale?: string; maxChunkScalars?: number },
  ) => Promise<{
    iterate: () => AsyncIterable<{
      outputArray: ArrayLike<number>;
      chunkIndex?: number;
      sentenceChunk?: string;
    }>;
    stats?: { audioDurationMs?: number; totalSamples?: number };
  }>;
}

const SAMPLE_RATE_CHATTERBOX = 24000;
const SAMPLE_RATE_SUPERTONIC = 44100;

// Approximate "plausible length": at least 50 ms of audio at the engine's
// native sample rate. We intentionally test PCM length rather than per-sample
// values so the test is engine-agnostic and resilient to silence / DSP tweaks.
const MIN_SAMPLES_50_MS_CHATTERBOX = Math.floor(SAMPLE_RATE_CHATTERBOX * 0.05);
const MIN_SAMPLES_50_MS_SUPERTONIC = Math.floor(SAMPLE_RATE_SUPERTONIC * 0.05);

function makeFakePcm(sampleCount: number): Int16Array {
  const pcm = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    // Synthetic sawtooth so non-empty + sample values are deterministic.
    pcm[i] = ((i * 73) % 32767) - 16384;
  }
  return pcm;
}

function makeChatterboxFakeModel(opts: {
  sampleCount: number;
  text?: string;
}): FakeTtsModel & AnyModel {
  const { sampleCount } = opts;
  return {
    async run(_input) {
      const pcm = makeFakePcm(sampleCount);
      return {
        async *iterate() {
          yield { outputArray: pcm };
        },
        iterate() {
          const pcmInner = pcm;
          return (async function* () {
            yield { outputArray: pcmInner };
          })();
        },
        stats: {
          audioDurationMs: Math.round(
            (sampleCount / SAMPLE_RATE_CHATTERBOX) * 1000,
          ),
          totalSamples: sampleCount,
        },
      };
    },
    async runStream(text, _options) {
      const sentences = text.split(".").filter((s) => s.trim().length > 0);
      const perSentence = Math.max(
        1,
        Math.floor(sampleCount / sentences.length),
      );
      return {
        iterate() {
          return (async function* () {
            for (let i = 0; i < sentences.length; i += 1) {
              yield {
                outputArray: makeFakePcm(perSentence),
                chunkIndex: i,
                sentenceChunk: sentences[i].trim() + ".",
              };
            }
          })();
        },
        stats: {
          audioDurationMs: Math.round(
            (sampleCount / SAMPLE_RATE_CHATTERBOX) * 1000,
          ),
          totalSamples: sampleCount,
        },
      };
    },
  } as unknown as FakeTtsModel & AnyModel;
}

function makeSupertonicFakeModel(opts: {
  sampleCount: number;
}): FakeTtsModel & AnyModel {
  const { sampleCount } = opts;
  return {
    async run(_input) {
      const pcm = makeFakePcm(sampleCount);
      return {
        iterate() {
          return (async function* () {
            yield { outputArray: pcm };
          })();
        },
        stats: {
          audioDurationMs: Math.round(
            (sampleCount / SAMPLE_RATE_SUPERTONIC) * 1000,
          ),
          totalSamples: sampleCount,
        },
      };
    },
    async runStream(_text, _options) {
      const pcm = makeFakePcm(sampleCount);
      return {
        iterate() {
          return (async function* () {
            yield { outputArray: pcm, chunkIndex: 0, sentenceChunk: "Stub." };
          })();
        },
        stats: {
          audioDurationMs: Math.round(
            (sampleCount / SAMPLE_RATE_SUPERTONIC) * 1000,
          ),
          totalSamples: sampleCount,
        },
      };
    },
  } as unknown as FakeTtsModel & AnyModel;
}

async function drainTextToSpeech(req: TtsRequest): Promise<{
  buffers: number[][];
  finalReturn: { modelExecutionMs: number; stats?: unknown };
}> {
  const buffers: number[][] = [];
  const generator = textToSpeech(req);
  let result = await generator.next();
  while (!result.done) {
    buffers.push(result.value.buffer);
    result = await generator.next();
  }
  return { buffers, finalReturn: result.value };
}

test("textToSpeech (Chatterbox shape): aggregates one-shot run() into non-empty Int16 PCM with plausible length", async (t: {
  ok: (cond: unknown, msg?: string) => void;
  is: (a: unknown, b: unknown, msg?: string) => void;
  alike: (a: unknown, b: unknown) => void;
}) => {
  const modelId = `tts-ggml-chatterbox-fake-${Math.random().toString(36).slice(2, 10)}`;
  const sampleCount = SAMPLE_RATE_CHATTERBOX; // exactly 1 second of audio
  const fakeModel = makeChatterboxFakeModel({
    sampleCount,
    text: "Hello world.",
  });

  registerModel(modelId, {
    model: fakeModel,
    path: "/tmp/chatterbox-t3.gguf",
    config: { ttsEngine: "chatterbox", language: "en" },
    modelType: ModelType.ggmlTts,
  });

  try {
    const { buffers, finalReturn } = await drainTextToSpeech({
      type: "textToSpeech",
      modelId,
      text: "Hello world.",
      inputType: "text",
      stream: false,
    });

    t.is(
      buffers.length,
      1,
      "non-stream mode yields exactly one aggregated buffer",
    );
    const buffer = buffers[0];
    t.ok(buffer.length > 0, "buffer is non-empty");
    t.ok(
      buffer.length >= MIN_SAMPLES_50_MS_CHATTERBOX,
      `buffer length (${buffer.length}) >= 50 ms at 24 kHz (${MIN_SAMPLES_50_MS_CHATTERBOX})`,
    );
    t.ok(
      buffer.every((s) => Number.isInteger(s) && s >= -32768 && s <= 32767),
      "every sample is a signed 16-bit integer (Int16 PCM)",
    );
    t.is(
      buffer.length,
      sampleCount,
      "aggregated PCM length matches model output",
    );
    t.ok(
      typeof finalReturn.modelExecutionMs === "number" &&
        finalReturn.modelExecutionMs >= 0,
      "final return carries non-negative modelExecutionMs",
    );
  } finally {
    unregisterModel(modelId);
  }
});

test("textToSpeech (Chatterbox shape): sentenceStream yields per-sentence Int16 PCM chunks", async (t: {
  ok: (cond: unknown, msg?: string) => void;
  is: (a: unknown, b: unknown, msg?: string) => void;
  alike: (a: unknown, b: unknown) => void;
}) => {
  const modelId = `tts-ggml-chatterbox-stream-${Math.random().toString(36).slice(2, 10)}`;
  const sampleCount = SAMPLE_RATE_CHATTERBOX * 2; // ~2 seconds
  const fakeModel = makeChatterboxFakeModel({ sampleCount });

  registerModel(modelId, {
    model: fakeModel,
    path: "/tmp/chatterbox-t3.gguf",
    config: { ttsEngine: "chatterbox", language: "en" },
    modelType: ModelType.ggmlTts,
  });

  try {
    const { buffers } = await drainTextToSpeech({
      type: "textToSpeech",
      modelId,
      text: "First sentence. Second sentence.",
      inputType: "text",
      stream: true,
      sentenceStream: true,
      sentenceStreamLocale: "en-US",
    });

    t.ok(
      buffers.length >= 2,
      `streaming yielded ${buffers.length} chunks (>=2 sentences)`,
    );
    for (const buf of buffers) {
      t.ok(buf.length > 0, "each chunk carries non-empty Int16 PCM");
      t.ok(
        buf.every((s) => Number.isInteger(s) && s >= -32768 && s <= 32767),
        "each chunk's samples fall in Int16 range",
      );
    }
  } finally {
    unregisterModel(modelId);
  }
});

test("textToSpeech (Supertonic shape): aggregates non-stream run() into non-empty Int16 PCM at 44.1 kHz length floor", async (t: {
  ok: (cond: unknown, msg?: string) => void;
  is: (a: unknown, b: unknown, msg?: string) => void;
  alike: (a: unknown, b: unknown) => void;
}) => {
  const modelId = `tts-ggml-supertonic-fake-${Math.random().toString(36).slice(2, 10)}`;
  const sampleCount = SAMPLE_RATE_SUPERTONIC; // exactly 1 second at 44.1 kHz
  const fakeModel = makeSupertonicFakeModel({ sampleCount });

  registerModel(modelId, {
    model: fakeModel,
    path: "/tmp/supertonic.gguf",
    config: {
      ttsEngine: "supertonic",
      language: "en",
      ttsSpeed: 1.05,
      ttsNumInferenceSteps: 5,
    },
    modelType: ModelType.ggmlTts,
  });

  try {
    const { buffers, finalReturn } = await drainTextToSpeech({
      type: "textToSpeech",
      modelId,
      text: "Supertonic output of approximately one second.",
      inputType: "text",
      stream: false,
    });

    t.is(
      buffers.length,
      1,
      "non-stream mode yields exactly one aggregated buffer",
    );
    const buffer = buffers[0];
    t.ok(buffer.length > 0, "buffer is non-empty");
    t.ok(
      buffer.length >= MIN_SAMPLES_50_MS_SUPERTONIC,
      `buffer length (${buffer.length}) >= 50 ms at 44.1 kHz (${MIN_SAMPLES_50_MS_SUPERTONIC})`,
    );
    t.ok(
      buffer.every((s) => Number.isInteger(s) && s >= -32768 && s <= 32767),
      "every sample is a signed 16-bit integer (Int16 PCM)",
    );
    t.is(
      buffer.length,
      sampleCount,
      "aggregated PCM length matches model output (no truncation by the SDK glue)",
    );
    t.ok(
      typeof finalReturn.modelExecutionMs === "number" &&
        finalReturn.modelExecutionMs >= 0,
      "final return carries non-negative modelExecutionMs",
    );
  } finally {
    unregisterModel(modelId);
  }
});
