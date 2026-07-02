import test from "brittle";
import {
  loadModelOptionsToRequestSchema,
  loadModelSrcRequestSchema,
} from "@/schemas/load-model";
import { llmConfigBaseSchema, ModelType } from "@/schemas";
import {
  getExplicitRegistryMetadata,
  resolveRegistryDownloadMetadata,
} from "@/server/rpc/handlers/load-model/registry-metadata";
import type { RegistryItem } from "@/models/registry";

test("loadModelSrcRequestSchema: rejects unknown top-level keys", (t) => {
  const invalidRequest = {
    type: "loadModel",
    modelType: ModelType.llamacppCompletion,
    modelSrc: "model.gguf",
    modelConfig: {},
    unknownTopLevelField: "should-fail",
  };

  const result = loadModelSrcRequestSchema.safeParse(invalidRequest);
  t.is(result.success, false);
});

test("loadModelOptionsToRequestSchema: points misplaced LLM config fields to modelConfig", (t) => {
  try {
    loadModelOptionsToRequestSchema.parse({
      modelSrc: "model.gguf",
      modelType: "llm",
      ctx_size: 2048,
    });
    t.fail("expected misplaced ctx_size to fail validation");
  } catch (error) {
    t.ok(error instanceof Error);
    t.ok(
      error instanceof Error && error.message.includes("modelConfig.ctx_size"),
    );
  }
});

test("loadModelOptionsToRequestSchema: points misplaced non-LLM config fields to modelConfig", (t) => {
  const cases = [
    {
      input: {
        modelSrc: "whisper.bin",
        modelType: "whisper",
        language: "en",
      },
      hint: "modelConfig.language",
    },
    {
      input: {
        modelSrc: "embed.gguf",
        modelType: "embeddings",
        batchSize: 512,
      },
      hint: "modelConfig.batchSize",
    },
  ];

  for (const { input, hint } of cases) {
    try {
      loadModelOptionsToRequestSchema.parse(input);
      t.fail(`expected misplaced ${hint} to fail validation`);
    } catch (error) {
      t.ok(error instanceof Error);
      t.ok(error instanceof Error && error.message.includes(hint));
    }
  }
});

test("loadModelSrcRequestSchema: accepts companion sources inside modelConfig", (t) => {
  const validWhisperRequest = {
    type: "loadModel",
    modelType: ModelType.whispercppTranscription,
    modelSrc: "model.bin",
    modelConfig: {
      language: "en",
      vadModelSrc: "vad.bin",
    },
  };

  const validOcrRequest = {
    type: "loadModel",
    modelType: ModelType.ggmlOcr,
    modelSrc: "recognizer.gguf",
    modelConfig: {
      detectorModelSrc: "detector.gguf",
    },
  };

  t.is(loadModelSrcRequestSchema.safeParse(validWhisperRequest).success, true);
  t.is(loadModelSrcRequestSchema.safeParse(validOcrRequest).success, true);
});

test("llmConfigBaseSchema: preserves projection descriptor cache metadata", (t) => {
  const descriptor = {
    src: "registry://hf/future/Qwen3.5-2B.mmproj-Q8_0.gguf",
    name: "MMPROJ_QWEN3_5_2B_MULTIMODAL_Q8_0",
    expectedSize: 364_664_384,
    sha256Checksum:
      "526dbf85f350baf3a5107b1f14e629e94571c7cbab4277476fbdaaa8c4a31a64",
  };

  const parsed = llmConfigBaseSchema.parse({
    projectionModelSrc: descriptor,
  });

  t.alike(parsed.projectionModelSrc, descriptor);
});

test("getExplicitRegistryMetadata: ignores non-registry descriptors", (t) => {
  const metadata = getExplicitRegistryMetadata({
    src: "https://example.com/model.gguf",
    expectedSize: 123,
    sha256Checksum:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });

  t.is(metadata, undefined);
});

test("getExplicitRegistryMetadata: ignores registry descriptors without cache metadata", (t) => {
  const metadata = getExplicitRegistryMetadata({
    src: "registry://hf/future/model.gguf",
    name: "FUTURE_MODEL",
  });

  t.is(metadata, undefined);
});

test("resolveRegistryDownloadMetadata: descriptor metadata covers uncatalogued registry paths", (t) => {
  const metadata = resolveRegistryDownloadMetadata(
    undefined,
    {
      expectedSize: 364_664_384,
      sha256Checksum:
        "526dbf85f350baf3a5107b1f14e629e94571c7cbab4277476fbdaaa8c4a31a64",
    },
    undefined,
  );

  t.is(metadata.expectedSize, 364_664_384);
  t.is(
    metadata.checksum,
    "526dbf85f350baf3a5107b1f14e629e94571c7cbab4277476fbdaaa8c4a31a64",
  );
});

test("resolveRegistryDownloadMetadata: catalog metadata wins over descriptor metadata", (t) => {
  const catalogMetadata: RegistryItem = {
    name: "CATALOG_MODEL",
    registryPath: "known/model.gguf",
    registrySource: "hf",
    blobCoreKey: "catalog-core-key",
    blobBlockOffset: 1,
    blobBlockLength: 2,
    blobByteOffset: 3,
    modelId: "model.gguf",
    addon: "llm",
    expectedSize: 123,
    sha256Checksum:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    engine: "llamacpp-completion",
    quantization: "q4_0",
    params: "1B",
  };

  const metadata = resolveRegistryDownloadMetadata(
    catalogMetadata,
    {
      expectedSize: 999,
      sha256Checksum:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );

  t.is(metadata.expectedSize, 123);
  t.is(
    metadata.checksum,
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
});

test("loadModelSrcRequestSchema: accepts classification load with empty modelSrc (bundled weights)", (t) => {
  // Classification ships bundled GGUF weights, so callers can omit modelSrc.
  // The client-side transform produces modelSrc: "" in that case; the server
  // schema must accept it without falling through to the custom-plugin arm.
  const bundledLoad = {
    type: "loadModel",
    modelType: ModelType.ggmlClassification,
    modelSrc: "",
    modelConfig: {},
  };

  const bundledWithTopK = {
    type: "loadModel",
    modelType: ModelType.ggmlClassification,
    modelSrc: "",
    modelConfig: { topK: 3 },
  };

  const customGguf = {
    type: "loadModel",
    modelType: ModelType.ggmlClassification,
    modelSrc: "/path/to/my-classifier.gguf",
    modelConfig: {},
  };

  t.is(loadModelSrcRequestSchema.safeParse(bundledLoad).success, true);
  t.is(loadModelSrcRequestSchema.safeParse(bundledWithTopK).success, true);
  t.is(loadModelSrcRequestSchema.safeParse(customGguf).success, true);
});

test("loadModelRequestSchema: custom plugin allows unknown modelConfig keys", (t) => {
  const customPluginRequest = {
    type: "loadModel",
    modelType: "my-custom-plugin",
    modelSrc: "model.bin",
    modelConfig: {
      customOption1: "value1",
      customOption2: 123,
      nestedConfig: { deep: true },
    },
  };

  const result = loadModelSrcRequestSchema.safeParse(customPluginRequest);
  t.is(result.success, true);
  if (result.success) {
    t.is(
      (result.data.modelConfig as Record<string, unknown>)?.customOption1,
      "value1",
    );
  }
});
