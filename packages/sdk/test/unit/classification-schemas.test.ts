import test from "brittle";
import { z } from "zod";
import {
  classificationConfigSchema,
  classifyRequestSchema,
  classifyResponseSchema,
  classificationResultSchema,
  modelInfoSchema,
  ModelType,
  type ClassificationResult,
} from "@/schemas";
import {
  loadModelSrcRequestSchema,
  loadModelOptionsBaseSchema,
  loadClassificationModelRequestSchema,
} from "@/schemas/load-model";
import { clearPlugins, registerPlugin, hasPlugin } from "@/server/plugins";
import {
  registerModel,
  unregisterModel,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import { handlePluginInvokeStream } from "@/server/rpc/handlers/plugin-invoke";
import { classify as classifyOp } from "@/server/bare/plugins/ggml-classification/ops/classify";
import { encodeBase64 } from "@/utils/encoding";

// ============================================
// classificationConfigSchema
// ============================================

test("classificationConfigSchema: accepts empty config", (t) => {
  const result = classificationConfigSchema.safeParse({});
  t.is(result.success, true);
});

test("classificationConfigSchema: accepts modelPath", (t) => {
  const result = classificationConfigSchema.safeParse({
    modelPath: "/abs/path/to/weights.gguf",
  });
  t.is(result.success, true);
});

test("classificationConfigSchema: accepts topK", (t) => {
  const result = classificationConfigSchema.safeParse({ topK: 3 });
  t.is(result.success, true);
});

test("classificationConfigSchema: rejects non-integer topK", (t) => {
  const result = classificationConfigSchema.safeParse({ topK: 2.5 });
  t.is(result.success, false);
});

test("classificationConfigSchema: accepts nativeLogger flag", (t) => {
  const result = classificationConfigSchema.safeParse({ nativeLogger: true });
  t.is(result.success, true);
});

test("classificationConfigSchema.strict(): rejects unknown keys", (t) => {
  const result = classificationConfigSchema
    .strict()
    .safeParse({ unknownKey: true });
  t.is(result.success, false);
});

// ============================================
// classificationResultSchema
// ============================================

test("classificationResultSchema: accepts {label, confidence}", (t) => {
  const result = classificationResultSchema.safeParse({
    label: "food",
    confidence: 0.93,
  });
  t.is(result.success, true);
});

test("classificationResultSchema: rejects missing fields", (t) => {
  const result = classificationResultSchema.safeParse({ label: "food" });
  t.is(result.success, false);
});

// ============================================
// classifyRequestSchema
// ============================================

function makeValidClassifyRequest() {
  return {
    type: "classify" as const,
    modelId: "test-model",
    image: encodeBase64(new Uint8Array([0xff, 0xd8, 0xff])), // JPEG magic
  };
}

test("classifyRequestSchema: accepts minimal request", (t) => {
  const result = classifyRequestSchema.safeParse(makeValidClassifyRequest());
  t.is(result.success, true);
});

test("classifyRequestSchema: accepts optional topK", (t) => {
  const result = classifyRequestSchema.safeParse({
    ...makeValidClassifyRequest(),
    topK: 5,
  });
  t.is(result.success, true);
});

test("classifyRequestSchema: accepts raw RGB with width/height/channels=3", (t) => {
  const result = classifyRequestSchema.safeParse({
    ...makeValidClassifyRequest(),
    width: 224,
    height: 224,
    channels: 3,
  });
  t.is(result.success, true);
});

test("classifyRequestSchema: rejects channels != 3", (t) => {
  const result = classifyRequestSchema.safeParse({
    ...makeValidClassifyRequest(),
    width: 224,
    height: 224,
    channels: 4,
  });
  t.is(result.success, false);
});

test("classifyRequestSchema: rejects missing modelId", (t) => {
  const { modelId: _, ...rest } = makeValidClassifyRequest();
  const result = classifyRequestSchema.safeParse(rest);
  t.is(result.success, false);
});

test("classifyRequestSchema: rejects missing image", (t) => {
  const { image: _, ...rest } = makeValidClassifyRequest();
  const result = classifyRequestSchema.safeParse(rest);
  t.is(result.success, false);
});

// ============================================
// classifyResponseSchema
// ============================================

test("classifyResponseSchema: accepts terminal response", (t) => {
  const result = classifyResponseSchema.safeParse({
    type: "classify",
    results: [{ label: "food", confidence: 0.91 }],
    done: true,
  });
  t.is(result.success, true);
});

test("classifyResponseSchema: accepts empty results array", (t) => {
  const result = classifyResponseSchema.safeParse({
    type: "classify",
    results: [],
    done: true,
  });
  t.is(result.success, true);
});

test("classifyResponseSchema: done is optional", (t) => {
  const result = classifyResponseSchema.safeParse({
    type: "classify",
    results: [{ label: "food", confidence: 0.91 }],
  });
  t.is(result.success, true);
});

// ============================================
// load-model integration (modelType: 'classification' / 'ggml-classification')
// ============================================

test("loadModelSrcRequestSchema: accepts classification request with canonical type", (t) => {
  const result = loadModelSrcRequestSchema.safeParse({
    type: "loadModel",
    modelType: ModelType.ggmlClassification,
    modelSrc: "",
    modelConfig: { topK: 3 },
  });
  t.is(result.success, true);
  if (result.success) {
    t.is(result.data.modelType, ModelType.ggmlClassification);
  }
});

test("loadClassificationModelRequestSchema: accepts request without modelConfig", (t) => {
  const result = loadClassificationModelRequestSchema.safeParse({
    type: "loadModel",
    modelType: ModelType.ggmlClassification,
    modelSrc: "",
  });
  t.is(result.success, true);
});

test("loadModelOptionsBaseSchema: accepts classification alias", (t) => {
  const result = loadModelOptionsBaseSchema.safeParse({
    modelType: "classification",
  });
  t.is(result.success, true);
});

test("loadModelOptionsBaseSchema: accepts classification with custom modelSrc", (t) => {
  const result = loadModelOptionsBaseSchema.safeParse({
    modelSrc: "/abs/path/to/my-classifier.gguf",
    modelType: "classification",
    modelConfig: { topK: 3 },
  });
  t.is(result.success, true);
});

test("loadModelOptionsBaseSchema: rejects classification config with unknown key (strict)", (t) => {
  const result = loadModelOptionsBaseSchema.safeParse({
    modelType: "classification",
    modelConfig: { topK: 3, unknownKey: true },
  });
  t.is(result.success, false);
});

// ============================================
// modelInfoSchema — addon enum includes 'classification'
// ============================================

test("modelInfoSchema: accepts addon 'classification'", (t) => {
  const result = modelInfoSchema.safeParse({
    name: "mobilenetv3-small",
    modelId: "mobilenetv3_3class_v3_fp16.gguf",
    expectedSize: 12000000,
    sha256Checksum: "abc123",
    addon: "classification",
    isCached: true,
    isLoaded: false,
    cacheFiles: [],
  });
  t.is(result.success, true);
});

// ============================================
// Plugin registration & handler dispatch (mock plugin)
//
// Mirrors the vla-plugin test pattern: register a mock plugin with the
// canonical classification modelType, register a mock model, dispatch
// through the real plugin-invoke handler, and assert on what the
// handler sees.
// ============================================

async function withMockClassificationPlugin<T>(
  classifyHandler: (
    request: unknown,
  ) => AsyncGenerator<unknown> | Promise<unknown>,
  body: (modelId: string) => Promise<T>,
): Promise<T> {
  clearPlugins();
  const modelId = `test-classify-mock-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const mockPlugin = {
    modelType: ModelType.ggmlClassification,
    displayName: "Classification (mock)",
    addonPackage: "@qvac/classification-ggml",
    loadConfigSchema: classificationConfigSchema,
    skipPrimaryModelPathValidation: true,
    createModel: function () {
      return { model: { load: async function () {} } };
    },
    handlers: {
      classify: {
        requestSchema: classifyRequestSchema as z.ZodType,
        responseSchema: classifyResponseSchema as z.ZodType,
        streaming: true,
        handler: classifyHandler,
      },
    },
  };
  try {
    registerPlugin(mockPlugin);
    registerModel(modelId, {
      model: {} as unknown as AnyModel,
      path: "",
      config: {},
      modelType: ModelType.ggmlClassification,
    });
    return await body(modelId);
  } finally {
    unregisterModel(modelId);
    clearPlugins();
  }
}

test("classification plugin: registers and dispatches classify", async function (t) {
  const expectedResults: ClassificationResult[] = [
    { label: "food", confidence: 0.93 },
    { label: "report", confidence: 0.05 },
    { label: "other", confidence: 0.02 },
  ];

  await withMockClassificationPlugin(
    async function* () {
      yield {
        type: "classify" as const,
        results: expectedResults,
        done: true,
      };
    },
    async (modelId) => {
      t.ok(hasPlugin(ModelType.ggmlClassification));

      // classify is `streaming: true`, so dispatch via the stream
      // plugin-invoke path. handlePluginInvokeStream wraps each handler
      // yield in `{type, result, done: false}` then emits a terminal
      // `{result: null, done: true}` after the generator drains.
      const envelopes: { type: string; result: unknown; done: boolean }[] = [];
      for await (const envelope of handlePluginInvokeStream({
        type: "pluginInvokeStream",
        modelId,
        handler: "classify",
        params: {
          type: "classify",
          modelId,
          image: encodeBase64(new Uint8Array([0])),
        },
      })) {
        envelopes.push(
          envelope as { type: string; result: unknown; done: boolean },
        );
      }

      // Our mock handler yields once, so expect 2 envelopes: data + terminator.
      t.is(envelopes.length, 2);
      t.is(envelopes[0]?.type, "pluginInvokeStream");
      t.is(envelopes[0]?.done, false);
      t.is(envelopes[1]?.done, true);
      t.is(envelopes[1]?.result, null);

      const data = envelopes[0]?.result as Record<string, unknown>;
      t.is((data["results"] as ClassificationResult[]).length, 3);
      t.is((data["results"] as ClassificationResult[])[0]?.label, "food");
      t.is(data["done"], true);
    },
  );
});

// ============================================
// classify op — base64 round-trip & model.classify wiring
// ============================================

async function withRegisteredClassificationModel<T>(
  options: {
    classifyImpl: (
      image: Uint8Array,
      opts: {
        topK?: number;
        width?: number;
        height?: number;
        channels?: 3;
      },
    ) => Promise<ClassificationResult[]>;
  },
  body: (modelId: string) => Promise<T>,
): Promise<T> {
  const modelId = `test-classify-${Math.random().toString(36).slice(2, 10)}`;
  const fakeModel = {
    load: async function () {},
    classify: options.classifyImpl,
  } as unknown as AnyModel;

  try {
    registerModel(modelId, {
      model: fakeModel,
      path: "",
      config: {},
      modelType: ModelType.ggmlClassification,
    });
    return await body(modelId);
  } finally {
    unregisterModel(modelId);
  }
}

test("classify op: decodes base64 image and forwards bytes to model.classify", async function (t) {
  let observedImage: Uint8Array | undefined;
  let observedOpts: Record<string, unknown> | undefined;
  const expectedResults: ClassificationResult[] = [
    { label: "food", confidence: 0.91 },
  ];

  await withRegisteredClassificationModel(
    {
      classifyImpl: async function (image, opts) {
        observedImage = image;
        observedOpts = opts;
        return expectedResults;
      },
    },
    async (modelId) => {
      const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
      const result = await classifyOp({
        type: "classify",
        modelId,
        image: encodeBase64(imageBytes),
      });

      t.ok(observedImage instanceof Uint8Array);
      t.is(observedImage?.length, imageBytes.length);
      t.is(observedImage?.[0], 0xff);
      t.is(observedImage?.[1], 0xd8);
      t.alike(observedOpts, {}, "no options forwarded when none provided");
      t.alike(result.results, expectedResults);
      t.ok(typeof result.modelExecutionMs === "number");
    },
  );
});

test("classify op: forwards topK/width/height/channels when provided", async function (t) {
  let observedOpts: Record<string, unknown> | undefined;

  await withRegisteredClassificationModel(
    {
      classifyImpl: async function (_image, opts) {
        observedOpts = opts;
        return [];
      },
    },
    async (modelId) => {
      await classifyOp({
        type: "classify",
        modelId,
        image: encodeBase64(new Uint8Array([0])),
        topK: 3,
        width: 224,
        height: 224,
        channels: 3,
      });

      t.is(observedOpts?.["topK"], 3);
      t.is(observedOpts?.["width"], 224);
      t.is(observedOpts?.["height"], 224);
      t.is(observedOpts?.["channels"], 3);
    },
  );
});

test("classify op: throws when loaded model does not support classify()", async function (t) {
  const modelId = `test-classify-noop-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  registerModel(modelId, {
    model: { load: async function () {} } as unknown as AnyModel,
    path: "",
    config: {},
    modelType: ModelType.ggmlClassification,
  });

  try {
    let err: unknown;
    try {
      await classifyOp({
        type: "classify",
        modelId,
        image: encodeBase64(new Uint8Array([0])),
      });
    } catch (e) {
      err = e;
    }
    t.ok(err instanceof Error);
    t.ok(
      (err as Error).message.includes("does not support classify"),
      "error message identifies the missing method",
    );
  } finally {
    unregisterModel(modelId);
  }
});
