import test from "brittle";
import { bciConfigSchema } from "@/schemas/bci-config";
import {
  neuralInputSchema,
  bciTranscribeClientParamsSchema,
  bciTranscribeRequestSchema,
  bciTranscribeResponseSchema,
  bciStreamOptsSchema,
  bciTranscribeStreamRequestSchema,
  bciTranscribeStreamResponseSchema,
} from "@/schemas/bci";
import { requestSchema, responseSchema } from "@/schemas/common";
import {
  loadModelSrcRequestSchema,
  loadModelOptionsToRequestSchema,
} from "@/schemas/load-model";
import { ModelType } from "@/schemas";

// === bciConfigSchema (engine config) ===

test("bciConfigSchema: accepts an empty config", (t) => {
  const result = bciConfigSchema.parse({});
  t.alike(result, {});
});

test("bciConfigSchema: accepts the full nested config shape", (t) => {
  const result = bciConfigSchema.parse({
    whisperConfig: { language: "en", n_threads: 4, temperature: 0.0 },
    bciConfig: { day_idx: 1 },
    contextParams: { use_gpu: false, flash_attn: true },
    miscConfig: { caption_enabled: false },
    backendsDir: "/tmp/backends",
    embedderModelSrc: "bci-embedder.bin",
  });
  t.is(result.whisperConfig?.language, "en");
  t.is(result.bciConfig?.day_idx, 1);
  t.is(result.miscConfig?.caption_enabled, false);
  t.is(result.embedderModelSrc, "bci-embedder.bin");
});

test("bciConfigSchema: accepts day_idx -1 (mel passthrough)", (t) => {
  const result = bciConfigSchema.parse({ bciConfig: { day_idx: -1 } });
  t.is(result.bciConfig?.day_idx, -1);
});

test("bciConfigSchema: rejects a non-integer day_idx", (t) => {
  const result = bciConfigSchema.safeParse({ bciConfig: { day_idx: 1.5 } });
  t.is(result.success, false);
});

test("bciConfigSchema: rejects a non-integer n_threads", (t) => {
  const result = bciConfigSchema.safeParse({
    whisperConfig: { n_threads: 2.5 },
  });
  t.is(result.success, false);
});

// === neuralInputSchema (wire input) ===

test("neuralInputSchema: accepts base64 and filePath variants", (t) => {
  t.is(
    neuralInputSchema.safeParse({ type: "base64", value: "AAAA" }).success,
    true,
  );
  t.is(
    neuralInputSchema.safeParse({ type: "filePath", value: "/a/b.bin" })
      .success,
    true,
  );
});

test("neuralInputSchema: rejects an unknown discriminant", (t) => {
  const result = neuralInputSchema.safeParse({ type: "url", value: "x" });
  t.is(result.success, false);
});

test("neuralInputSchema: rejects a variant missing its value", (t) => {
  const result = neuralInputSchema.safeParse({ type: "base64" });
  t.is(result.success, false);
});

// === bciTranscribeClientParamsSchema (batch client input) ===

test("bciTranscribeClientParamsSchema: accepts path and Uint8Array neuralData", (t) => {
  const pathResult = bciTranscribeClientParamsSchema.safeParse({
    modelId: "model-1",
    neuralData: "/a/b.bin",
  });
  const bytesResult = bciTranscribeClientParamsSchema.safeParse({
    modelId: "model-1",
    neuralData: new Uint8Array([1, 2, 3]),
    metadata: true,
  });

  t.is(pathResult.success, true);
  t.is(bytesResult.success, true);
});

test("bciTranscribeClientParamsSchema: rejects non-neuralData values", (t) => {
  const result = bciTranscribeClientParamsSchema.safeParse({
    modelId: "model-1",
    neuralData: { type: "filePath", value: "/a/b.bin" },
  });

  t.is(result.success, false);
});

// === bciTranscribeRequestSchema / bciTranscribeResponseSchema (batch) ===

test("bciTranscribeRequestSchema: accepts a minimal valid request", (t) => {
  const result = bciTranscribeRequestSchema.safeParse({
    type: "bciTranscribe",
    modelId: "model-1",
    neuralData: { type: "filePath", value: "/a/b.bin" },
  });
  t.is(result.success, true);
});

test("bciTranscribeRequestSchema: accepts metadata + requestId", (t) => {
  const result = bciTranscribeRequestSchema.safeParse({
    type: "bciTranscribe",
    modelId: "model-1",
    neuralData: { type: "base64", value: "AAAA" },
    metadata: true,
    requestId: "req-1",
  });
  t.is(result.success, true);
});

test("bciTranscribeRequestSchema: rejects an empty requestId", (t) => {
  const result = bciTranscribeRequestSchema.safeParse({
    type: "bciTranscribe",
    modelId: "model-1",
    neuralData: { type: "base64", value: "AAAA" },
    requestId: "",
  });
  t.is(result.success, false);
});

test("bciTranscribeRequestSchema: rejects a request missing neuralData", (t) => {
  const result = bciTranscribeRequestSchema.safeParse({
    type: "bciTranscribe",
    modelId: "model-1",
  });
  t.is(result.success, false);
});

test("bciTranscribeResponseSchema: accepts minimal and full payloads", (t) => {
  t.is(
    bciTranscribeResponseSchema.safeParse({ type: "bciTranscribe" }).success,
    true,
  );
  t.is(
    bciTranscribeResponseSchema.safeParse({
      type: "bciTranscribe",
      text: "not too controversial",
      done: true,
      segment: {
        text: "not too controversial",
        startMs: 0,
        endMs: 1200,
        append: true,
        id: 0,
      },
    }).success,
    true,
  );
});

// === bciStreamOptsSchema (streaming knobs) ===

test("bciStreamOptsSchema: accepts an empty opts object", (t) => {
  t.alike(bciStreamOptsSchema.parse({}), {});
});

test("bciStreamOptsSchema: accepts a full opts object", (t) => {
  const result = bciStreamOptsSchema.parse({
    windowTimesteps: 1500,
    hopTimesteps: 500,
    emit: "full",
  });
  t.is(result.windowTimesteps, 1500);
  t.is(result.hopTimesteps, 500);
  t.is(result.emit, "full");
});

test("bciStreamOptsSchema: rejects a non-positive windowTimesteps", (t) => {
  t.is(bciStreamOptsSchema.safeParse({ windowTimesteps: 0 }).success, false);
});

test("bciStreamOptsSchema: rejects a non-integer hopTimesteps", (t) => {
  t.is(bciStreamOptsSchema.safeParse({ hopTimesteps: 10.5 }).success, false);
});

test("bciStreamOptsSchema: rejects hopTimesteps greater than or equal to windowTimesteps", (t) => {
  const equalResult = bciStreamOptsSchema.safeParse({
    windowTimesteps: 500,
    hopTimesteps: 500,
  });
  const greaterResult = bciStreamOptsSchema.safeParse({
    windowTimesteps: 500,
    hopTimesteps: 501,
  });

  t.is(equalResult.success, false);
  t.is(greaterResult.success, false);
});

test("bciStreamOptsSchema: rejects an unknown emit mode", (t) => {
  t.is(bciStreamOptsSchema.safeParse({ emit: "partial" }).success, false);
});

// === bciTranscribeStreamRequestSchema / response (duplex) ===

test("bciTranscribeStreamRequestSchema: accepts a minimal request", (t) => {
  const result = bciTranscribeStreamRequestSchema.safeParse({
    type: "bciTranscribeStream",
    modelId: "model-1",
  });
  t.is(result.success, true);
});

test("bciTranscribeStreamRequestSchema: accepts streamOpts + metadata", (t) => {
  const result = bciTranscribeStreamRequestSchema.safeParse({
    type: "bciTranscribeStream",
    modelId: "model-1",
    metadata: true,
    streamOpts: { windowTimesteps: 1500, hopTimesteps: 500, emit: "delta" },
    requestId: "req-stream-1",
  });
  t.is(result.success, true);
});

test("bciTranscribeStreamRequestSchema: rejects an empty requestId", (t) => {
  const result = bciTranscribeStreamRequestSchema.safeParse({
    type: "bciTranscribeStream",
    modelId: "model-1",
    requestId: "",
  });
  t.is(result.success, false);
});

test("bciTranscribeStreamRequestSchema: rejects invalid streamOpts", (t) => {
  const result = bciTranscribeStreamRequestSchema.safeParse({
    type: "bciTranscribeStream",
    modelId: "model-1",
    streamOpts: { windowTimesteps: -1 },
  });
  t.is(result.success, false);
});

test("bciTranscribeStreamResponseSchema: accepts a minimal payload", (t) => {
  t.is(
    bciTranscribeStreamResponseSchema.safeParse({
      type: "bciTranscribeStream",
    }).success,
    true,
  );
});

// === union integration (wire request/response routing) ===

test("requestSchema: routes BCI batch and stream requests", (t) => {
  t.is(
    requestSchema.safeParse({
      type: "bciTranscribe",
      modelId: "model-1",
      neuralData: { type: "filePath", value: "/a/b.bin" },
    }).success,
    true,
  );
  t.is(
    requestSchema.safeParse({
      type: "bciTranscribeStream",
      modelId: "model-1",
    }).success,
    true,
  );
});

test("responseSchema: routes BCI batch and stream responses", (t) => {
  t.is(
    responseSchema.safeParse({ type: "bciTranscribe", text: "hi", done: true })
      .success,
    true,
  );
  t.is(
    responseSchema.safeParse({ type: "bciTranscribeStream", text: "hi" })
      .success,
    true,
  );
});

// === loadModel integration (BCI branch) ===

// The client-facing options schema accepts the `"bci"` alias and resolves
// it to the canonical model type, lifting the nested BCI config through.
test("loadModelOptionsToRequestSchema: resolves the 'bci' alias to the canonical type", (t) => {
  const result = loadModelOptionsToRequestSchema.safeParse({
    modelType: "bci",
    modelSrc: "ggml-bci-windowed.bin",
    modelConfig: {
      whisperConfig: { language: "en", temperature: 0.0 },
      bciConfig: { day_idx: 1 },
      miscConfig: { caption_enabled: false },
    },
  });
  t.is(result.success, true);
  if (result.success) {
    t.is(result.data.modelType, ModelType.bciWhispercppTranscription);
  }
});

test("loadModelOptionsToRequestSchema: rejects unknown modelConfig keys for BCI (strict)", (t) => {
  const result = loadModelOptionsToRequestSchema.safeParse({
    modelType: "bci-whispercpp-transcription",
    modelSrc: "ggml-bci-windowed.bin",
    modelConfig: { notABciField: true },
  });
  t.is(result.success, false);
});

// The server-side request schema is canonical-only (aliases are resolved
// client-side before the wire), so it must accept the canonical model type.
test("loadModelSrcRequestSchema: accepts a BCI load via the canonical modelType", (t) => {
  const result = loadModelSrcRequestSchema.safeParse({
    type: "loadModel",
    modelType: ModelType.bciWhispercppTranscription,
    modelSrc: "ggml-bci-windowed.bin",
    modelConfig: {},
  });
  t.is(result.success, true);
});
