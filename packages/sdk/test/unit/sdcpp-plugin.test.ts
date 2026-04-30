// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { z } from "zod";
import {
  sdcppConfigSchema,
  diffusionRequestSchema,
  diffusionStreamResponseSchema,
  diffusionStatsSchema,
  modelInfoSchema,
  ModelType,
  SDK_SERVER_ERROR_CODES,
  type DiffusionStreamResponse,
  type PluginInvokeStreamResponse,
} from "@/schemas";
import {
  loadModelSrcRequestSchema,
  loadModelOptionsBaseSchema,
} from "@/schemas/load-model";
import { clearPlugins, registerPlugin, hasPlugin } from "@/server/plugins";
import {
  registerModel,
  unregisterModel,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import { handlePluginInvokeStream } from "@/server/rpc/handlers/plugin-invoke";
import {
  PluginResponseValidationFailedError,
  PluginRequestValidationFailedError,
} from "@/utils/errors-server";

// ============================================
// sdcppConfigSchema
// ============================================

test("sdcppConfigSchema: accepts empty config", (t) => {
  const result = sdcppConfigSchema.safeParse({});
  t.is(result.success, true);
});

test("sdcppConfigSchema: accepts valid full config", (t) => {
  const result = sdcppConfigSchema.safeParse({
    threads: 4,
    device: "gpu",
    prediction: "flow",
    type: "q8_0",
    rng: "cpu",
    sampler_rng: "std_default",
    clip_on_cpu: true,
    vae_on_cpu: false,
    vae_tiling: true,
    flash_attn: true,
    verbosity: 2,
    clipLModelSrc: "clip-l.safetensors",
    clipGModelSrc: "clip-g.safetensors",
    t5XxlModelSrc: "t5xxl.safetensors",
    llmModelSrc: "qwen3.gguf",
    vaeModelSrc: "vae.safetensors",
  });
  t.is(result.success, true);
});

test("sdcppConfigSchema: rejects invalid device", (t) => {
  const result = sdcppConfigSchema.safeParse({ device: "tpu" });
  t.is(result.success, false);
});

test("sdcppConfigSchema: rejects invalid prediction type", (t) => {
  const result = sdcppConfigSchema.safeParse({ prediction: "unknown" });
  t.is(result.success, false);
});

test("sdcppConfigSchema: rejects invalid type", (t) => {
  const result = sdcppConfigSchema.safeParse({ type: "q3_0" });
  t.is(result.success, false);
});

test("sdcppConfigSchema.strict(): rejects unknown keys", (t) => {
  const result = sdcppConfigSchema.strict().safeParse({ unknownKey: true });
  t.is(result.success, false);
});

// ============================================
// diffusionStatsSchema
// ============================================

test("diffusionStatsSchema: accepts all C++ RuntimeStats fields", (t) => {
  const result = diffusionStatsSchema.safeParse({
    modelLoadMs: 500,
    generationMs: 1234,
    totalGenerationMs: 1234,
    totalWallMs: 1734,
    totalSteps: 20,
    totalGenerations: 1,
    totalImages: 1,
    totalPixels: 262144,
    width: 512,
    height: 512,
    seed: 42,
  });
  t.is(result.success, true);
});

test("diffusionStatsSchema: accepts empty stats", (t) => {
  const result = diffusionStatsSchema.safeParse({});
  t.is(result.success, true);
});

test("diffusionStatsSchema: strips unknown fields (no passthrough)", (t) => {
  const result = diffusionStatsSchema.safeParse({
    modelLoadMs: 100,
    unknownField: "should-be-stripped",
  });
  t.is(result.success, true);
  if (result.success) {
    t.is(result.data.modelLoadMs, 100);
    t.absent((result.data as Record<string, unknown>)["unknownField"]);
  }
});

// ============================================
// diffusionRequestSchema
// ============================================

test("diffusionRequestSchema: accepts minimal txt2img request", (t) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "a cat sitting on a windowsill",
  });
  t.is(result.success, true);
});

test("diffusionRequestSchema: accepts full txt2img request", (t) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "a cat",
    negative_prompt: "ugly",
    width: 512,
    height: 768,
    steps: 20,
    cfg_scale: 7.0,
    guidance: 3.5,
    sampling_method: "euler_a",
    scheduler: "karras",
    seed: 42,
    batch_count: 2,
    vae_tiling: true,
    cache_preset: "fast",
  });
  t.is(result.success, true);
});

test("diffusionRequestSchema: applies img_cfg_scale default of -1 when omitted", (t) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "a cat",
  });
  t.is(result.success, true);
  if (result.success) {
    t.is(result.data.img_cfg_scale, -1);
  }
});

test("diffusionRequestSchema: preserves explicit img_cfg_scale value", (t) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "a cat",
    img_cfg_scale: 4.5,
  });
  t.is(result.success, true);
  if (result.success) {
    t.is(result.data.img_cfg_scale, 4.5);
  }
});

test("diffusionRequestSchema: rejects missing modelId", (t) => {
  const result = diffusionRequestSchema.safeParse({
    prompt: "a cat",
  });
  t.is(result.success, false);
});

test("diffusionRequestSchema: rejects missing prompt", (t) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: "model-1",
  });
  t.is(result.success, false);
});

test("diffusionRequestSchema: rejects width not multiple of 8", (t) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "a cat",
    width: 513,
  });
  t.is(result.success, false);
});

test("diffusionRequestSchema: rejects negative steps", (t) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "a cat",
    steps: -1,
  });
  t.is(result.success, false);
});

test("diffusionRequestSchema: rejects invalid sampling_method", (t) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "a cat",
    sampling_method: "ddpm",
  });
  t.is(result.success, false);
});

test("diffusionRequestSchema: rejects invalid scheduler", (t) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "a cat",
    scheduler: "default",
  });
  t.is(result.success, false);
});

test("diffusionRequestSchema: accepts img2img request with init_image and strength", (t) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "oil painting style",
    init_image: "iVBORw0KGgoAAAANSUhEUg==",
    strength: 0.7,
  });
  t.is(result.success, true);
});

test("diffusionRequestSchema: accepts img2img request with init_image only (no strength)", (t) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "watercolor",
    init_image: "iVBORw0KGgoAAAANSUhEUg==",
  });
  t.is(result.success, true);
});

test("diffusionRequestSchema: rejects strength below 0", (t) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "a cat",
    strength: -0.1,
  });
  t.is(result.success, false);
});

test("diffusionRequestSchema: rejects strength above 1", (t) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "a cat",
    strength: 1.5,
  });
  t.is(result.success, false);
});

test("diffusionRequestSchema: rejects empty init_image", (t) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "a cat",
    init_image: "",
  });
  t.is(result.success, false);
});

test("diffusionRequestSchema: rejects init_image with invalid base64 characters", (t) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "a cat",
    init_image: "not valid base64!!!",
  });
  t.is(result.success, false);
});

test("diffusionRequestSchema: rejects init_image with base64url characters (-, _)", (t) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "a cat",
    init_image: "iVBORw0KGgoAAAANSUhE-_==",
  });
  t.is(result.success, false);
});

test("diffusionRequestSchema: rejects init_image with embedded whitespace", (t) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "a cat",
    init_image: "iVBORw0KGgo\nAAAANSUhEUg==",
  });
  t.is(result.success, false);
});

test("diffusionRequestSchema: rejects init_image with length not a multiple of 4", (t) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "a cat",
    init_image: "iVBORw0KGgoAAAANSUhEUg",
  });
  t.is(result.success, false);
});

test("diffusionRequestSchema: accepts strength at boundaries (0 and 1)", (t) => {
  const resultZero = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "a cat",
    strength: 0,
  });
  t.is(resultZero.success, true);

  const resultOne = diffusionRequestSchema.safeParse({
    modelId: "model-1",
    prompt: "a cat",
    strength: 1,
  });
  t.is(resultOne.success, true);
});

// ============================================
// diffusionStreamResponseSchema
// ============================================

test("diffusionStreamResponseSchema: accepts progress tick", (t) => {
  const result = diffusionStreamResponseSchema.safeParse({
    type: "diffusionStream",
    step: 5,
    totalSteps: 20,
    elapsedMs: 1234,
  });
  t.is(result.success, true);
});

test("diffusionStreamResponseSchema: accepts output data chunk", (t) => {
  const result = diffusionStreamResponseSchema.safeParse({
    type: "diffusionStream",
    data: "iVBORw0KGgoAAAANSUhEUg==",
    outputIndex: 0,
  });
  t.is(result.success, true);
});

test("diffusionStreamResponseSchema: accepts final done chunk with stats", (t) => {
  const result = diffusionStreamResponseSchema.safeParse({
    type: "diffusionStream",
    done: true,
    stats: {
      generationMs: 1234,
      totalSteps: 20,
      width: 512,
      height: 512,
      seed: 42,
    },
  });
  t.is(result.success, true);
});

test("diffusionStreamResponseSchema: rejects wrong type literal", (t) => {
  const result = diffusionStreamResponseSchema.safeParse({
    type: "completionStream",
    step: 1,
  });
  t.is(result.success, false);
});

// ============================================
// loadModelSrcRequestSchema — diffusion entries
// ============================================

test("loadModelSrcRequestSchema: accepts diffusion request with canonical type", (t) => {
  const result = loadModelSrcRequestSchema.safeParse({
    type: "loadModel",
    modelType: ModelType.sdcppGeneration,
    modelSrc: "model.safetensors",
    modelConfig: { device: "gpu", threads: 4 },
  });
  t.is(result.success, true);
  if (result.success) {
    t.is(result.data.modelType, ModelType.sdcppGeneration);
  }
});

test("loadModelSrcRequestSchema: accepts diffusion request with no modelConfig", (t) => {
  const result = loadModelSrcRequestSchema.safeParse({
    type: "loadModel",
    modelType: ModelType.sdcppGeneration,
    modelSrc: "model.safetensors",
  });
  t.is(result.success, true);
});

test("loadModelSrcRequestSchema: rejects diffusion request with unknown top-level key", (t) => {
  const result = loadModelSrcRequestSchema.safeParse({
    type: "loadModel",
    modelType: ModelType.sdcppGeneration,
    modelSrc: "model.safetensors",
    extraField: true,
  });
  t.is(result.success, false);
});

test("loadModelSrcRequestSchema: accepts diffusion config with companion sources", (t) => {
  const result = loadModelSrcRequestSchema.safeParse({
    type: "loadModel",
    modelType: ModelType.sdcppGeneration,
    modelSrc: "flux2-klein.gguf",
    modelConfig: {
      device: "gpu",
      clipLModelSrc: "clip-l.safetensors",
      vaeModelSrc: "vae.safetensors",
      llmModelSrc: "qwen3.gguf",
    },
  });
  t.is(result.success, true);
});

// ============================================
// loadModelOptionsBaseSchema — diffusion entries
// ============================================

test("loadModelOptionsBaseSchema: accepts diffusion with alias", (t) => {
  const result = loadModelOptionsBaseSchema.safeParse({
    modelSrc: "model.safetensors",
    modelType: "diffusion",
    modelConfig: { device: "cpu" },
  });
  t.is(result.success, true);
});

test("loadModelOptionsBaseSchema: rejects diffusion with unknown config key (strict)", (t) => {
  const result = loadModelOptionsBaseSchema.safeParse({
    modelSrc: "model.safetensors",
    modelType: "diffusion",
    modelConfig: { device: "gpu", notAField: true },
  });
  t.is(result.success, false);
});

// ============================================
// Plugin registration & handler dispatch
// ============================================

// Registers a diffusion plugin whose only per-test variation is the handler
// body, registers a mock model, runs `body` with the generated modelId, and
// tears everything down (even if `body` throws).
async function withMockDiffusionPlugin<T>(
  handler: (request: unknown) => AsyncGenerator<unknown>,
  body: (modelId: string) => Promise<T>,
): Promise<T> {
  clearPlugins();
  const modelId = `test-diffusion-mock-${Math.random().toString(36).slice(2, 10)}`;
  const mockPlugin = {
    modelType: ModelType.sdcppGeneration,
    displayName: "Image Generation (stable-diffusion.cpp)",
    addonPackage: "@qvac/diffusion-cpp",
    loadConfigSchema: sdcppConfigSchema,
    createModel: function () {
      return { model: { load: async function () {} } };
    },
    handlers: {
      diffusionStream: {
        requestSchema: diffusionRequestSchema as z.ZodType,
        responseSchema: diffusionStreamResponseSchema as z.ZodType,
        streaming: true,
        handler,
      },
    },
  };
  try {
    registerPlugin(mockPlugin);
    registerModel(modelId, {
      model: {} as unknown as AnyModel,
      path: "/tmp/model.safetensors",
      config: {},
      modelType: ModelType.sdcppGeneration,
    });
    return await body(modelId);
  } finally {
    unregisterModel(modelId);
    clearPlugins();
  }
}

test("diffusion plugin: registers and dispatches diffusionStream", async function (t) {
  await withMockDiffusionPlugin(
    async function* () {
      yield {
        type: "diffusionStream" as const,
        step: 1,
        totalSteps: 2,
        elapsedMs: 100,
      };
      yield {
        type: "diffusionStream" as const,
        data: "iVBORw0KGgo=",
        outputIndex: 0,
      };
      yield {
        type: "diffusionStream" as const,
        done: true,
        stats: { generationMs: 200, totalSteps: 2, width: 512, height: 512 },
      };
    },
    async (modelId) => {
      t.ok(hasPlugin(ModelType.sdcppGeneration));

      const stream = handlePluginInvokeStream({
        type: "pluginInvokeStream",
        modelId,
        handler: "diffusionStream",
        params: { modelId, prompt: "a cat" },
      });

      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      t.is(chunks.length, 4);

      t.is(chunks[0]!.done, false);
      const progressData = chunks[0]!.result as Record<string, unknown>;
      t.is(progressData.step, 1);
      t.is(progressData.totalSteps, 2);

      const outputData = chunks[1]!.result as Record<string, unknown>;
      t.ok(typeof outputData.data === "string");
      t.is(outputData.outputIndex, 0);

      const finalData = chunks[2]!.result as Record<string, unknown>;
      t.is(finalData.done, true);
      t.ok(finalData.stats);
      const stats = finalData.stats as Record<string, unknown>;
      t.is(stats.generationMs, 200);
      t.is(stats.totalSteps, 2);

      t.is(chunks[3]!.done, true);
      t.is(chunks[3]!.result, null);
    },
  );
});

test("diffusion plugin: img2img request reaches handler verbatim after safeParse (init_image, strength, img_cfg_scale default)", async function (t) {
  const initImageBase64 = "iVBORw0KGgoAAAANSUhEUg==";
  let observedRequest: unknown = undefined;

  await withMockDiffusionPlugin(
    async function* (request: unknown) {
      observedRequest = request;
      yield { type: "diffusionStream" as const, done: true };
    },
    async (modelId) => {
      const requestParams = {
        modelId,
        prompt: "oil painting",
        init_image: initImageBase64,
        strength: 0.65,
      };

      const stream = handlePluginInvokeStream({
        type: "pluginInvokeStream",
        modelId,
        handler: "diffusionStream",
        params: requestParams,
      });

      // Drain so the handler runs and observedRequest gets populated.
      for await (const _ of stream) {
        // no-op
      }

      t.alike(observedRequest, { ...requestParams, img_cfg_scale: -1 });
    },
  );
});

test("diffusion plugin: dispatcher forwards interleaved multi-tick + multi-output stream verbatim", async function (t) {
  const yieldedChunks: DiffusionStreamResponse[] = [
    { type: "diffusionStream", step: 7, totalSteps: 23, elapsedMs: 110 },
    { type: "diffusionStream", step: 14, totalSteps: 23, elapsedMs: 220 },
    { type: "diffusionStream", step: 21, totalSteps: 23, elapsedMs: 330 },
    { type: "diffusionStream", data: "AAAAQUFBQQ==", outputIndex: 0 },
    { type: "diffusionStream", data: "BBBBQkJCQg==", outputIndex: 1 },
    {
      type: "diffusionStream",
      done: true,
      stats: {
        generationMs: 419,
        totalSteps: 23,
        width: 768,
        height: 512,
        seed: 13,
      },
    },
  ];

  await withMockDiffusionPlugin(
    async function* () {
      for (const chunk of yieldedChunks) {
        yield chunk;
      }
    },
    async (modelId) => {
      const stream = handlePluginInvokeStream({
        type: "pluginInvokeStream",
        modelId,
        handler: "diffusionStream",
        params: { modelId, prompt: "anything" },
      });

      const chunks: PluginInvokeStreamResponse[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      for (let i = 0; i < yieldedChunks.length; i++) {
        t.alike(chunks[i], {
          type: "pluginInvokeStream",
          result: yieldedChunks[i],
          done: false,
        });
      }
    },
  );
});

test("diffusion plugin: appends { result: null, done: true } sentinel after handler completes", async function (t) {
  const yieldedChunks: DiffusionStreamResponse[] = [
    { type: "diffusionStream", step: 1, totalSteps: 1, elapsedMs: 50 },
  ];

  await withMockDiffusionPlugin(
    async function* () {
      for (const chunk of yieldedChunks) {
        yield chunk;
      }
    },
    async (modelId) => {
      const stream = handlePluginInvokeStream({
        type: "pluginInvokeStream",
        modelId,
        handler: "diffusionStream",
        params: { modelId, prompt: "anything" },
      });

      const chunks: PluginInvokeStreamResponse[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      t.is(chunks.length, yieldedChunks.length + 1);
      t.alike(chunks[chunks.length - 1], {
        type: "pluginInvokeStream",
        result: null,
        done: true,
      });
    },
  );
});

test("diffusion plugin: rejects invalid request schema", async function (t) {
  await withMockDiffusionPlugin(
    async function* () {
      yield { type: "diffusionStream" as const, done: true };
    },
    async (modelId) => {
      const stream = handlePluginInvokeStream({
        type: "pluginInvokeStream",
        modelId,
        handler: "diffusionStream",
        params: { noModelId: true, noPrompt: true },
      });

      try {
        await stream.next();
        t.fail("Expected request validation to throw");
      } catch (error) {
        t.ok(error instanceof PluginRequestValidationFailedError);
        t.is(
          (error as PluginRequestValidationFailedError).code,
          SDK_SERVER_ERROR_CODES.PLUGIN_REQUEST_VALIDATION_FAILED,
        );
      }
    },
  );
});

test("diffusion plugin: rejects invalid response from handler", async function (t) {
  await withMockDiffusionPlugin(
    async function* () {
      yield { type: "wrongType", badField: 123 };
    },
    async (modelId) => {
      const stream = handlePluginInvokeStream({
        type: "pluginInvokeStream",
        modelId,
        handler: "diffusionStream",
        params: { modelId, prompt: "a cat" },
      });

      try {
        await stream.next();
        t.fail("Expected response validation to throw");
      } catch (error) {
        t.ok(error instanceof PluginResponseValidationFailedError);
        t.is(
          (error as PluginResponseValidationFailedError).code,
          SDK_SERVER_ERROR_CODES.PLUGIN_RESPONSE_VALIDATION_FAILED,
        );
      }
    },
  );
});

test("diffusion plugin: stats with all RuntimeStats fields passes response validation", async function (t) {
  const fullStats = {
    modelLoadMs: 500,
    generationMs: 1234,
    totalGenerationMs: 1234,
    totalWallMs: 1734,
    totalSteps: 20,
    totalGenerations: 1,
    totalImages: 1,
    totalPixels: 262144,
    width: 512,
    height: 512,
    seed: 42,
  };

  await withMockDiffusionPlugin(
    async function* () {
      yield {
        type: "diffusionStream" as const,
        done: true,
        stats: fullStats,
      };
    },
    async (modelId) => {
      const stream = handlePluginInvokeStream({
        type: "pluginInvokeStream",
        modelId,
        handler: "diffusionStream",
        params: { modelId, prompt: "a cat" },
      });

      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      t.is(chunks.length, 2);

      const statsChunk = chunks[0]!.result as Record<string, unknown>;
      const receivedStats = statsChunk.stats as Record<string, unknown>;

      t.is(receivedStats.modelLoadMs, 500);
      t.is(receivedStats.generationMs, 1234);
      t.is(receivedStats.totalGenerationMs, 1234);
      t.is(receivedStats.totalWallMs, 1734);
      t.is(receivedStats.totalSteps, 20);
      t.is(receivedStats.totalGenerations, 1);
      t.is(receivedStats.totalImages, 1);
      t.is(receivedStats.totalPixels, 262144);
      t.is(receivedStats.width, 512);
      t.is(receivedStats.height, 512);
      t.is(receivedStats.seed, 42);
    },
  );
});

// ============================================
// modelInfoSchema — addon enum includes "diffusion"
// ============================================

test("modelInfoSchema: accepts addon 'diffusion'", (t) => {
  const result = modelInfoSchema.safeParse({
    name: "flux2-klein",
    modelId: "flux2-klein-q4_0",
    expectedSize: 1000000,
    sha256Checksum: "abc123",
    addon: "diffusion",
    isCached: true,
    isLoaded: false,
    cacheFiles: [],
  });
  t.is(result.success, true);
});

test("modelInfoSchema: rejects addon not in enum", (t) => {
  const result = modelInfoSchema.safeParse({
    name: "test",
    modelId: "test-id",
    expectedSize: 1000,
    sha256Checksum: "abc",
    addon: "nonexistent",
    isCached: false,
    isLoaded: false,
    cacheFiles: [],
  });
  t.is(result.success, false);
});

// ============================================
// resolveConfig — companion source extraction
// ============================================

test("sdcppConfigSchema: companion source fields are valid modelSrcInput", (t) => {
  const configs = [
    { clipLModelSrc: "clip-l.safetensors" },
    { clipGModelSrc: "registry://clip-g" },
    { t5XxlModelSrc: "t5xxl.gguf" },
    { llmModelSrc: "qwen3-8b.gguf" },
    { vaeModelSrc: "vae.safetensors" },
    {
      clipLModelSrc: "clip-l.safetensors",
      clipGModelSrc: "clip-g.safetensors",
      t5XxlModelSrc: "t5xxl.gguf",
      llmModelSrc: "qwen3.gguf",
      vaeModelSrc: "vae.safetensors",
    },
  ];

  for (const cfg of configs) {
    const result = sdcppConfigSchema.safeParse(cfg);
    t.is(result.success, true, `Failed for: ${JSON.stringify(cfg)}`);
  }
});

test("sdcppConfigSchema: companion sources are stripped from config by resolveConfig contract", (t) => {
  const input = {
    threads: 4,
    device: "gpu" as const,
    clipLModelSrc: "clip-l.safetensors",
    vaeModelSrc: "vae.safetensors",
  };

  const result = sdcppConfigSchema.safeParse(input);
  t.is(result.success, true);

  if (result.success) {
    t.is(result.data.threads, 4);
    t.is(result.data.device, "gpu");
    t.ok("clipLModelSrc" in result.data);
    t.ok("vaeModelSrc" in result.data);
  }
});
