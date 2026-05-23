// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { z } from "zod";
import {
  vlaConfigSchema,
  vlaHparamsSchema,
  vlaRunRequestSchema,
  vlaRunResponseSchema,
  vlaHparamsRequestSchema,
  vlaHparamsResponseSchema,
  vlaStatsSchema,
  modelInfoSchema,
  ModelType,
} from "@/schemas";
import {
  loadModelSrcRequestSchema,
  loadModelOptionsBaseSchema,
} from "@/schemas/load-model";
import {
  vlaPreprocessImage,
  vlaPadState,
  VLA_DEFAULT_IMAGE_SIZE,
} from "@/client/api/vla-helpers";
import { clearPlugins, registerPlugin, hasPlugin } from "@/server/plugins";
import {
  registerModel,
  unregisterModel,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import { handlePluginInvoke } from "@/server/rpc/handlers/plugin-invoke";
import { vlaRun } from "@/server/bare/plugins/ggml-vla/ops/vla-run";
import { vlaGetHparams } from "@/server/bare/plugins/ggml-vla/ops/vla-hparams";
import { encodeBase64 } from "@/utils/encoding";

// ============================================
// vlaConfigSchema
// ============================================

test("vlaConfigSchema: accepts empty config", (t) => {
  const result = vlaConfigSchema.safeParse({});
  t.is(result.success, true);
});

test("vlaConfigSchema: accepts backend 'auto'", (t) => {
  const result = vlaConfigSchema.safeParse({ backend: "auto" });
  t.is(result.success, true);
});

test("vlaConfigSchema: accepts backend 'cpu'", (t) => {
  const result = vlaConfigSchema.safeParse({ backend: "cpu" });
  t.is(result.success, true);
});

test("vlaConfigSchema: rejects unknown backend", (t) => {
  const result = vlaConfigSchema.safeParse({ backend: "vulkan" });
  t.is(result.success, false);
});

test("vlaConfigSchema: accepts verbosity integer", (t) => {
  const result = vlaConfigSchema.safeParse({ verbosity: 3 });
  t.is(result.success, true);
});

test("vlaConfigSchema: rejects non-integer verbosity", (t) => {
  const result = vlaConfigSchema.safeParse({ verbosity: 2.5 });
  t.is(result.success, false);
});

test("vlaConfigSchema.strict(): rejects unknown keys", (t) => {
  const result = vlaConfigSchema.strict().safeParse({ unknown: true });
  t.is(result.success, false);
});

// ============================================
// vlaHparamsSchema
// ============================================

test("vlaHparamsSchema: accepts canonical SmolVLA-LIBERO shape", (t) => {
  const result = vlaHparamsSchema.safeParse({
    chunkSize: 50,
    actionDim: 7,
    maxActionDim: 32,
    maxStateDim: 32,
    tokenizerMaxLength: 48,
    visionImageSize: 512,
  });
  t.is(result.success, true);
});

test("vlaHparamsSchema: rejects negative dims", (t) => {
  const result = vlaHparamsSchema.safeParse({
    chunkSize: -1,
    actionDim: 7,
    maxActionDim: 32,
    maxStateDim: 32,
    tokenizerMaxLength: 48,
    visionImageSize: 512,
  });
  t.is(result.success, false);
});

// ============================================
// vlaStatsSchema
// ============================================

test("vlaStatsSchema: accepts addon's full RuntimeStats shape", (t) => {
  const result = vlaStatsSchema.safeParse({
    vision_ms: 12.3,
    smollm2_compute_ms: 4.5,
    smollm2_total_ms: 7.1,
    ode_ms: 2.2,
    total_ms: 25.6,
    backendDevice: 1,
  });
  t.is(result.success, true);
});

test("vlaStatsSchema: accepts empty stats", (t) => {
  const result = vlaStatsSchema.safeParse({});
  t.is(result.success, true);
});

// ============================================
// vlaRunRequestSchema
// ============================================

function makeValidRunRequest() {
  const float = encodeBase64(new Uint8Array(new Float32Array([1, 2, 3]).buffer));
  const int = encodeBase64(new Uint8Array(new Int32Array([1, 2]).buffer));
  const u8 = encodeBase64(new Uint8Array([1, 1]));
  return {
    type: "vlaRun" as const,
    modelId: "model-1",
    images: [float],
    imgWidth: 256,
    imgHeight: 256,
    state: float,
    tokens: int,
    mask: u8,
  };
}

test("vlaRunRequestSchema: accepts valid request", (t) => {
  const result = vlaRunRequestSchema.safeParse(makeValidRunRequest());
  t.is(result.success, true);
});

test("vlaRunRequestSchema: accepts optional noise field", (t) => {
  const req = makeValidRunRequest();
  const noise = encodeBase64(new Uint8Array(new Float32Array([0, 0]).buffer));
  const result = vlaRunRequestSchema.safeParse({ ...req, noise });
  t.is(result.success, true);
});

test("vlaRunRequestSchema: rejects missing modelId", (t) => {
  const req = makeValidRunRequest() as Record<string, unknown>;
  delete req["modelId"];
  const result = vlaRunRequestSchema.safeParse(req);
  t.is(result.success, false);
});

test("vlaRunRequestSchema: rejects empty images array", (t) => {
  const result = vlaRunRequestSchema.safeParse({
    ...makeValidRunRequest(),
    images: [],
  });
  t.is(result.success, false);
});

test("vlaRunRequestSchema: rejects non-positive imgWidth", (t) => {
  const result = vlaRunRequestSchema.safeParse({
    ...makeValidRunRequest(),
    imgWidth: 0,
  });
  t.is(result.success, false);
});

test("vlaRunRequestSchema: rejects state with invalid base64 characters", (t) => {
  const result = vlaRunRequestSchema.safeParse({
    ...makeValidRunRequest(),
    state: "not valid base64!!!",
  });
  t.is(result.success, false);
});

// ============================================
// vlaRunResponseSchema
// ============================================

test("vlaRunResponseSchema: accepts minimal response", (t) => {
  const actions = encodeBase64(
    new Uint8Array(new Float32Array([0.1, 0.2]).buffer),
  );
  const result = vlaRunResponseSchema.safeParse({
    actions,
    actionDim: 7,
    chunkSize: 50,
  });
  t.is(result.success, true);
});

test("vlaRunResponseSchema: accepts response with stats", (t) => {
  const actions = encodeBase64(
    new Uint8Array(new Float32Array([0.1, 0.2]).buffer),
  );
  const result = vlaRunResponseSchema.safeParse({
    actions,
    actionDim: 7,
    chunkSize: 50,
    stats: { total_ms: 200 },
  });
  t.is(result.success, true);
});

// ============================================
// vlaHparams request/response schemas
// ============================================

test("vlaHparamsRequestSchema: accepts request", (t) => {
  const result = vlaHparamsRequestSchema.safeParse({
    type: "vlaHparams",
    modelId: "model-1",
  });
  t.is(result.success, true);
});

test("vlaHparamsResponseSchema: accepts response", (t) => {
  const result = vlaHparamsResponseSchema.safeParse({
    hparams: {
      chunkSize: 50,
      actionDim: 7,
      maxActionDim: 32,
      maxStateDim: 32,
      tokenizerMaxLength: 48,
      visionImageSize: 512,
    },
    backendName: "Vulkan",
  });
  t.is(result.success, true);
});

test("vlaHparamsResponseSchema: accepts null backendName", (t) => {
  const result = vlaHparamsResponseSchema.safeParse({
    hparams: {
      chunkSize: 50,
      actionDim: 7,
      maxActionDim: 32,
      maxStateDim: 32,
      tokenizerMaxLength: 48,
      visionImageSize: 512,
    },
    backendName: null,
  });
  t.is(result.success, true);
});

// ============================================
// load-model integration (modelType: 'vla' / canonical 'ggml-vla')
// ============================================

test("loadModelSrcRequestSchema: accepts vla request with canonical type", (t) => {
  const result = loadModelSrcRequestSchema.safeParse({
    type: "loadModel",
    modelType: ModelType.ggmlVla,
    modelSrc: "smolvla.gguf",
    modelConfig: { backend: "cpu" },
  });
  t.is(result.success, true);
  if (result.success) {
    t.is(result.data.modelType, ModelType.ggmlVla);
  }
});

test("loadModelOptionsBaseSchema: accepts vla alias", (t) => {
  const result = loadModelOptionsBaseSchema.safeParse({
    modelSrc: "smolvla.gguf",
    modelType: "vla",
    modelConfig: { backend: "auto" },
  });
  t.is(result.success, true);
});

test("loadModelOptionsBaseSchema: rejects vla config with unknown key (strict)", (t) => {
  const result = loadModelOptionsBaseSchema.safeParse({
    modelSrc: "smolvla.gguf",
    modelType: "vla",
    modelConfig: { backend: "cpu", unknownKey: true },
  });
  t.is(result.success, false);
});

// ============================================
// modelInfoSchema — addon enum includes 'vla'
// ============================================

test("modelInfoSchema: accepts addon 'vla'", (t) => {
  const result = modelInfoSchema.safeParse({
    name: "smolvla-libero",
    modelId: "smolvla-libero.gguf",
    expectedSize: 1900000000,
    sha256Checksum: "abc123",
    addon: "vla",
    isCached: true,
    isLoaded: false,
    cacheFiles: [],
  });
  t.is(result.success, true);
});

// ============================================
// vlaPreprocessImage — pure-JS helper
// ============================================

test("vlaPreprocessImage: produces a Float32Array of length 3*size*size", (t) => {
  const w = 64;
  const h = 64;
  const pixels = new Uint8Array(w * h * 3).fill(128);
  const out = vlaPreprocessImage(pixels, w, h, { size: 32 });
  t.ok(out instanceof Float32Array);
  t.is(out.length, 3 * 32 * 32);
});

test("vlaPreprocessImage: rejects wrong-sized pixel buffer", (t) => {
  let err: unknown;
  try {
    vlaPreprocessImage(new Uint8Array(10), 4, 4, { size: 8 });
  } catch (e) {
    err = e;
  }
  t.ok(err instanceof RangeError);
});

test("vlaPreprocessImage: maps mid-gray (0-255) to ~0 in [-1,1]", (t) => {
  const w = 8;
  const h = 8;
  const pixels = new Uint8Array(w * h * 3).fill(128);
  const out = vlaPreprocessImage(pixels, w, h, { size: 8 });
  // Mid-gray (128/255 ≈ 0.5) maps to ~0 in [-1, 1]. Center pixel of channel 0.
  const center = out[0 * 8 * 8 + 4 * 8 + 4];
  t.ok(
    center !== undefined && Math.abs(center) < 0.05,
    `center pixel ~ 0 (got: ${center})`,
  );
});

test("vlaPreprocessImage: pad region filled with -1", (t) => {
  // 16-wide, 8-tall — letterbox-pad in a square output. The addon places
  // content at the bottom-right (`padTop = size - newH`), so the pad rows
  // sit at the top. For w=16,h=8,size=16 the resized content occupies
  // rows 8-15 and the top row (row 0) is pad.
  const w = 16;
  const h = 8;
  const pixels = new Uint8Array(w * h * 3).fill(128);
  const out = vlaPreprocessImage(pixels, w, h, { size: 16 });
  // The top row should be in the pad region (-1).
  const top = out[0 * 16 * 16 + 0 * 16 + 0];
  t.is(top, -1);
});

// ============================================
// vlaPadState — pure-JS helper
// ============================================

test("vlaPadState: pads short vectors with zeros", (t) => {
  const out = vlaPadState([1, 2, 3], 6);
  t.is(out.length, 6);
  t.is(out[0], 1);
  t.is(out[1], 2);
  t.is(out[2], 3);
  t.is(out[3], 0);
  t.is(out[4], 0);
  t.is(out[5], 0);
});

test("vlaPadState: throws when input exceeds targetDim", (t) => {
  let err: unknown;
  try {
    vlaPadState([1, 2, 3, 4, 5], 3);
  } catch (e) {
    err = e;
  }
  t.ok(err instanceof RangeError);
});

test("vlaPadState: defaults targetDim to 32", (t) => {
  const out = vlaPadState([1, 2, 3]);
  t.is(out.length, 32);
  t.is(out[0], 1);
  t.is(out[2], 3);
  t.is(out[3], 0);
  t.is(out[31], 0);
});

test("VLA_DEFAULT_IMAGE_SIZE matches SmolVLA-LIBERO", (t) => {
  t.is(VLA_DEFAULT_IMAGE_SIZE, 512);
});

// ============================================
// Plugin registration & handler dispatch (mock plugin)
// ============================================

// Mirrors the diffusion-plugin test pattern: register a mock plugin with
// the canonical VLA modelType, register a mock model, dispatch through the
// real plugin-invoke handler, and assert on what the handler sees.
async function withMockVlaPlugin<T>(
  runHandler: (request: unknown) => Promise<unknown>,
  hparamsHandler: (request: unknown) => Promise<unknown>,
  body: (modelId: string) => Promise<T>,
): Promise<T> {
  clearPlugins();
  const modelId = `test-vla-mock-${Math.random().toString(36).slice(2, 10)}`;
  const mockPlugin = {
    modelType: ModelType.ggmlVla,
    displayName: "VLA (mock)",
    addonPackage: "@qvac/vla-ggml",
    loadConfigSchema: vlaConfigSchema,
    createModel: function () {
      return { model: { load: async function () {} } };
    },
    handlers: {
      vlaRun: {
        requestSchema: vlaRunRequestSchema as z.ZodType,
        responseSchema: vlaRunResponseSchema as z.ZodType,
        streaming: false,
        handler: runHandler,
      },
      vlaHparams: {
        requestSchema: vlaHparamsRequestSchema as z.ZodType,
        responseSchema: vlaHparamsResponseSchema as z.ZodType,
        streaming: false,
        handler: hparamsHandler,
      },
    },
  };
  try {
    registerPlugin(mockPlugin);
    registerModel(modelId, {
      model: {} as unknown as AnyModel,
      path: "/tmp/smolvla.gguf",
      config: {},
      modelType: ModelType.ggmlVla,
    });
    return await body(modelId);
  } finally {
    unregisterModel(modelId);
    clearPlugins();
  }
}

test("vla plugin: registers and dispatches vlaRun", async function (t) {
  const actions = encodeBase64(
    new Uint8Array(new Float32Array([0.1, 0.2, 0.3]).buffer),
  );
  await withMockVlaPlugin(
    async function () {
      return {
        actions,
        actionDim: 3,
        chunkSize: 1,
        stats: { total_ms: 42 },
      };
    },
    async function () {
      throw new Error("hparams not exercised in this test");
    },
    async (modelId) => {
      t.ok(hasPlugin(ModelType.ggmlVla));

      const result = await handlePluginInvoke({
        type: "pluginInvoke",
        modelId,
        handler: "vlaRun",
        params: { ...makeValidRunRequest(), modelId },
      });

      t.is(result.type, "pluginInvoke");
      const data = result.result as Record<string, unknown>;
      t.is(data["actions"], actions);
      t.is(data["actionDim"], 3);
      t.is(data["chunkSize"], 1);
    },
  );
});

test("vla plugin: dispatches vlaHparams", async function (t) {
  const hp = {
    chunkSize: 50,
    actionDim: 7,
    maxActionDim: 32,
    maxStateDim: 32,
    tokenizerMaxLength: 48,
    visionImageSize: 512,
  };
  await withMockVlaPlugin(
    async function () {
      throw new Error("run not exercised in this test");
    },
    async function () {
      return { hparams: hp, backendName: "CPU" };
    },
    async (modelId) => {
      const result = await handlePluginInvoke({
        type: "pluginInvoke",
        modelId,
        handler: "vlaHparams",
        params: { type: "vlaHparams", modelId },
      });
      const data = result.result as Record<string, unknown>;
      t.alike(data["hparams"], hp);
      t.is(data["backendName"], "CPU");
    },
  );
});

// ============================================
// vlaRun op — base64 round-trip & model.run wiring
// ============================================

async function withRegisteredVlaModel<T>(
  options: {
    runImpl: (input: unknown) => Promise<{
      await(): Promise<{ actions: Float32Array; stats?: Record<string, number> }>;
    }>;
    hparams: { actionDim: number; chunkSize: number };
  },
  body: (modelId: string) => Promise<T>,
): Promise<T> {
  const modelId = `test-vla-${Math.random().toString(36).slice(2, 10)}`;
  const fakeModel = {
    load: async function () {},
    run: options.runImpl,
    hparams: options.hparams,
    backendName: "CPU",
  } as unknown as AnyModel;

  try {
    registerModel(modelId, {
      model: fakeModel,
      path: "/tmp/smolvla.gguf",
      config: {},
      modelType: ModelType.ggmlVla,
    });
    return await body(modelId);
  } finally {
    unregisterModel(modelId);
  }
}

test("vlaRun op: decodes base64 inputs and forwards typed arrays to model.run", async function (t) {
  let observedInput: Record<string, unknown> | undefined;
  const expectedActions = new Float32Array([0.5, -0.25, 1.0]);
  await withRegisteredVlaModel(
    {
      runImpl: async function (input: unknown) {
        observedInput = input as Record<string, unknown>;
        return {
          await: async () => ({
            actions: expectedActions,
            stats: { total_ms: 100 },
          }),
        };
      },
      hparams: { actionDim: 3, chunkSize: 1 },
    },
    async (modelId) => {
      const imageBytes = new Float32Array([0.1, 0.2, 0.3, 0.4]);
      const stateBytes = new Float32Array([0, 0, 0]);
      const tokensBytes = new Int32Array([1, 0, 0]);
      const maskBytes = new Uint8Array([1, 0, 0]);

      const result = await vlaRun({
        type: "vlaRun",
        modelId,
        images: [encodeBase64(new Uint8Array(imageBytes.buffer))],
        imgWidth: 2,
        imgHeight: 2,
        state: encodeBase64(new Uint8Array(stateBytes.buffer)),
        tokens: encodeBase64(new Uint8Array(tokensBytes.buffer)),
        mask: encodeBase64(maskBytes),
      });

      t.ok(observedInput, "model.run was called");
      const images = observedInput?.["images"] as Float32Array[];
      t.is(images.length, 1);
      t.is(images[0]?.length, 4);
      // Float32 round-trip loses precision; expect within 1e-6 of source.
      t.ok(Math.abs((images[0]?.[0] ?? NaN) - 0.1) < 1e-6);

      t.is((observedInput?.["state"] as Float32Array).length, 3);
      t.is((observedInput?.["tokens"] as Int32Array)[0], 1);
      t.is((observedInput?.["mask"] as Uint8Array)[0], 1);
      t.is(observedInput?.["imgWidth"], 2);

      t.is(result.actionDim, 3);
      t.is(result.chunkSize, 1);
      t.is(result.stats?.total_ms, 100);
      // Round-trip the actions base64 by decoding here (mirrors what the
      // client does).
      const actionsB64 = result.actions;
      t.ok(typeof actionsB64 === "string" && actionsB64.length > 0);
    },
  );
});

test("vlaRun op: forwards optional noise when provided", async function (t) {
  let observedInput: Record<string, unknown> | undefined;
  await withRegisteredVlaModel(
    {
      runImpl: async function (input: unknown) {
        observedInput = input as Record<string, unknown>;
        return {
          await: async () => ({ actions: new Float32Array([0]) }),
        };
      },
      hparams: { actionDim: 1, chunkSize: 1 },
    },
    async (modelId) => {
      const noise = new Float32Array([0.7]);
      await vlaRun({
        type: "vlaRun",
        modelId,
        images: [encodeBase64(new Uint8Array(new Float32Array([0]).buffer))],
        imgWidth: 1,
        imgHeight: 1,
        state: encodeBase64(new Uint8Array(new Float32Array([0]).buffer)),
        tokens: encodeBase64(new Uint8Array(new Int32Array([0]).buffer)),
        mask: encodeBase64(new Uint8Array([0])),
        noise: encodeBase64(new Uint8Array(noise.buffer)),
      });

      const observedNoise = observedInput?.["noise"] as Float32Array;
      t.ok(observedNoise instanceof Float32Array);
      t.ok(Math.abs((observedNoise[0] ?? NaN) - 0.7) < 1e-6);
    },
  );
});

test("vlaRun op: omits noise when not provided", async function (t) {
  let observedInput: Record<string, unknown> | undefined;
  await withRegisteredVlaModel(
    {
      runImpl: async function (input: unknown) {
        observedInput = input as Record<string, unknown>;
        return {
          await: async () => ({ actions: new Float32Array([0]) }),
        };
      },
      hparams: { actionDim: 1, chunkSize: 1 },
    },
    async (modelId) => {
      await vlaRun({
        type: "vlaRun",
        modelId,
        images: [encodeBase64(new Uint8Array(new Float32Array([0]).buffer))],
        imgWidth: 1,
        imgHeight: 1,
        state: encodeBase64(new Uint8Array(new Float32Array([0]).buffer)),
        tokens: encodeBase64(new Uint8Array(new Int32Array([0]).buffer)),
        mask: encodeBase64(new Uint8Array([0])),
      });
      t.absent(observedInput?.["noise"], "noise omitted from forwarded input");
    },
  );
});

// ============================================
// vlaGetHparams op
// ============================================

test("vlaGetHparams op: returns the model's hparams + backend", async function (t) {
  const hp = {
    chunkSize: 50,
    actionDim: 7,
    maxActionDim: 32,
    maxStateDim: 32,
    tokenizerMaxLength: 48,
    visionImageSize: 512,
  };
  await withRegisteredVlaModel(
    {
      runImpl: async function () {
        throw new Error("run not exercised");
      },
      hparams: hp as unknown as { actionDim: number; chunkSize: number },
    },
    async (modelId) => {
      const result = await vlaGetHparams({ type: "vlaHparams", modelId });
      t.alike(result.hparams, hp);
      t.is(result.backendName, "CPU");
    },
  );
});
