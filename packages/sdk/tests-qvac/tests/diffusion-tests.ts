// Diffusion test definitions
import type { TestDefinition, TestResult } from "@tetherto/qvac-test-suite";

type DiffusionTestOptions = {
  estimatedDurationMs?: number;
  suites?: string[];
  dependency?: string;
};

const createDiffusionTest = (
  testId: string,
  params: Record<string, unknown>,
  expectation:
    | { validation: "type"; expectedType: "string" | "number" | "array" }
    | { validation: "throws-error"; errorContains: string }
    | { validation: "function"; fn: (result: unknown) => TestResult },
  options: DiffusionTestOptions = {},
): TestDefinition => {
  const {
    estimatedDurationMs = 300000,
    suites,
    dependency = "diffusion",
  } = options;
  return {
    testId,
    params,
    expectation,
    ...(suites && { suites }),
    metadata: {
      category: "diffusion",
      dependency,
      estimatedDurationMs,
    },
  };
};

// ---- txt2img ----

export const diffusionBasicTxt2img = createDiffusionTest(
  "diffusion-basic-txt2img",
  {
    prompt: "a solid red square on white background",
    width: 256,
    height: 256,
    steps: 4,
    seed: 42,
  },
  { validation: "type", expectedType: "array" },
  { suites: ["smoke"] },
);

export const diffusionDefaultSize = createDiffusionTest(
  "diffusion-default-size",
  {
    prompt: "a blue circle",
    width: 256,
    height: 256,
    steps: 2,
    seed: 42,
  },
  { validation: "type", expectedType: "array" },
);

export const diffusionNegativePrompt = createDiffusionTest(
  "diffusion-negative-prompt",
  {
    prompt: "a landscape painting",
    negative_prompt: "blurry, low quality",
    width: 256,
    height: 256,
    steps: 4,
    seed: 42,
  },
  { validation: "type", expectedType: "array" },
);

export const diffusionCfgScale = createDiffusionTest(
  "diffusion-cfg-scale",
  {
    prompt: "a mountain landscape",
    width: 256,
    height: 256,
    steps: 4,
    cfg_scale: 12.0,
    seed: 42,
  },
  { validation: "type", expectedType: "array" },
);

export const diffusionSamplerEulerA = createDiffusionTest(
  "diffusion-sampler-euler-a",
  {
    prompt: "a green forest",
    width: 256,
    height: 256,
    steps: 4,
    sampling_method: "euler_a",
    seed: 42,
  },
  { validation: "type", expectedType: "array" },
);

export const diffusionSamplerHeun = createDiffusionTest(
  "diffusion-sampler-heun",
  {
    prompt: "a sunset over ocean",
    width: 256,
    height: 256,
    steps: 4,
    sampling_method: "heun",
    seed: 42,
  },
  { validation: "type", expectedType: "array" },
);

export const diffusionSchedulerKarras = createDiffusionTest(
  "diffusion-scheduler-karras",
  {
    prompt: "abstract art",
    width: 256,
    height: 256,
    steps: 4,
    scheduler: "karras",
    seed: 42,
  },
  { validation: "type", expectedType: "array" },
);

export const diffusionSeedReproducibility = createDiffusionTest(
  "diffusion-seed-reproducibility",
  {
    prompt: "a red triangle",
    width: 256,
    height: 256,
    steps: 4,
    seed: 12345,
  },
  { validation: "type", expectedType: "string" },
  { estimatedDurationMs: 600000 },
);

export const diffusionBatchCount = createDiffusionTest(
  "diffusion-batch-count",
  {
    prompt: "a simple shape",
    width: 256,
    height: 256,
    steps: 4,
    batch_count: 2,
    seed: 42,
  },
  { validation: "type", expectedType: "array" },
  { estimatedDurationMs: 600000 },
);

// ---- img2img ----

export const diffusionBasicImg2img = createDiffusionTest(
  "diffusion-basic-img2img",
  {
    prompt: "oil painting style, vibrant colors",
    init_image: "elephant.jpg",
    strength: 0.5,
    width: 256,
    height: 256,
    steps: 4,
    seed: 42,
  },
  { validation: "type", expectedType: "array" },
);

// ---- streaming ----

export const diffusionStreaming = createDiffusionTest(
  "diffusion-streaming",
  {
    prompt: "a yellow star",
    width: 256,
    height: 256,
    steps: 4,
    seed: 42,
  },
  { validation: "type", expectedType: "array" },
);

export const diffusionStreamingProgress = createDiffusionTest(
  "diffusion-streaming-progress",
  {
    prompt: "a purple diamond",
    width: 256,
    height: 256,
    steps: 4,
    seed: 42,
  },
  { validation: "type", expectedType: "string" },
  { estimatedDurationMs: 300000, suites: ["smoke"] },
);

// ---- stats ----

export const diffusionStatsPresent = createDiffusionTest(
  "diffusion-stats-present",
  {
    prompt: "a white circle on black background",
    width: 256,
    height: 256,
    steps: 4,
    seed: 42,
  },
  { validation: "type", expectedType: "string" },
);

// ---- FLUX.2 multi-reference fusion ----

export const diffusionFusionFlux2Basic = createDiffusionTest(
  "diffusion-fusion-flux2-basic",
  {
    prompt: "a portrait using most visual traits from @image1 and the eyes from @image2",
    init_images: ["cat.jpg", "elephant.jpg"],
    width: 256,
    height: 256,
    steps: 4,
    seed: 42,
  },
  // Required by TestDefinition but effectively ignored - DiffusionExecutor.fusionFlux2Basic gates the result.
  { validation: "type", expectedType: "array" },
  { estimatedDurationMs: 600000 },
);

// ---- ESRGAN upscale ----

const ESRGAN_SCALE = 4;
const ESRGAN_SOURCE_WIDTH = 128;
const ESRGAN_SOURCE_HEIGHT = 128;
const STANDALONE_UPSCALER_SOURCE_WIDTH = 64;
const STANDALONE_UPSCALER_SOURCE_HEIGHT = 64;

// Decode the IHDR chunk (width/height as big-endian uint32 at offsets 16 and 20)
// and assert dimensions are source * scale.
function validateEsrganUpscale(result: unknown): TestResult {
  if (!Array.isArray(result) || result.length === 0) {
    return { passed: false, output: "No outputs generated" };
  }
  const output = result[0] as Uint8Array;
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  const expectedWidth = ESRGAN_SOURCE_WIDTH * ESRGAN_SCALE;
  const expectedHeight = ESRGAN_SOURCE_HEIGHT * ESRGAN_SCALE;
  const passed = width === expectedWidth && height === expectedHeight;
  return {
    passed,
    output: passed
      ? `ESRGAN x${ESRGAN_SCALE} upscale OK: ${ESRGAN_SOURCE_WIDTH}x${ESRGAN_SOURCE_HEIGHT} -> ${width}x${height}`
      : `Expected ${expectedWidth}x${expectedHeight} from ${ESRGAN_SOURCE_WIDTH}x${ESRGAN_SOURCE_HEIGHT} input, got ${width}x${height} (upscale not applied?)`,
  };
}

function validateStandaloneUpscale(result: unknown): TestResult {
  if (!Array.isArray(result) || result.length === 0) {
    return { passed: false, output: "No outputs generated" };
  }
  const output = result[0] as Uint8Array;
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  const expectedWidth = STANDALONE_UPSCALER_SOURCE_WIDTH * ESRGAN_SCALE;
  const expectedHeight = STANDALONE_UPSCALER_SOURCE_HEIGHT * ESRGAN_SCALE;
  const passed = width === expectedWidth && height === expectedHeight;
  return {
    passed,
    output: passed
      ? `Standalone upscaler x${ESRGAN_SCALE} OK: ${STANDALONE_UPSCALER_SOURCE_WIDTH}x${STANDALONE_UPSCALER_SOURCE_HEIGHT} -> ${width}x${height}`
      : `Expected ${expectedWidth}x${expectedHeight} from ${STANDALONE_UPSCALER_SOURCE_WIDTH}x${STANDALONE_UPSCALER_SOURCE_HEIGHT} input, got ${width}x${height}`,
  };
}

export const diffusionEsrganUpscaleX4 = createDiffusionTest(
  "diffusion-esrgan-upscale-x4",
  {
    prompt: "a solid red square on white background",
    width: ESRGAN_SOURCE_WIDTH,
    height: ESRGAN_SOURCE_HEIGHT,
    steps: 4,
    seed: 42,
    upscale: true,
  },
  { validation: "function", fn: validateEsrganUpscale },
  { estimatedDurationMs: 600000, dependency: "diffusion-esrgan" },
);

export const diffusionStandaloneUpscalerX4 = createDiffusionTest(
  "diffusion-standalone-upscaler-x4",
  {
    image: "small-64.jpg",
    repeats: 1,
  },
  { validation: "function", fn: validateStandaloneUpscale },
  { estimatedDurationMs: 600000, dependency: "upscaler" },
);

// ---- error cases ----

export const diffusionEmptyPrompt = createDiffusionTest(
  "diffusion-empty-prompt",
  {
    prompt: "",
    width: 256,
    height: 256,
    steps: 4,
  },
  { validation: "type", expectedType: "array" },
  { estimatedDurationMs: 60000 },
);

export const diffusionTests = [
  diffusionBasicTxt2img,
  diffusionDefaultSize,
  diffusionNegativePrompt,
  diffusionCfgScale,
  diffusionSamplerEulerA,
  diffusionSamplerHeun,
  diffusionSchedulerKarras,
  diffusionSeedReproducibility,
  diffusionBatchCount,
  diffusionBasicImg2img,
  diffusionStreaming,
  diffusionStreamingProgress,
  diffusionStatsPresent,
  diffusionFusionFlux2Basic,
  diffusionEsrganUpscaleX4,
  diffusionStandaloneUpscalerX4,
  diffusionEmptyPrompt,
];
