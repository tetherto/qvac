// Diffusion test definitions
import type { TestDefinition, TestResult } from "@tetherto/qvac-test-suite";

type ExpectationLike =
  | { validation: "type"; expectedType: "string" | "number" | "array" }
  | { validation: "throws-error"; errorContains: string }
  | { validation: "function"; fn: (result: unknown) => TestResult };

type DiffusionTestOptions = {
  estimatedDurationMs?: number;
  suites?: string[];
  dependency?: string;
};

// Generic so `typeof someTest.testId`/`typeof someTest.params` keep their literal
// types — that's what feeds `BaseExecutor`'s typed handlers map and lets each
// handler method see real `params` instead of `any`.
export type DiffusionTestDef<
  TId extends string,
  P extends Record<string, unknown>,
> = TestDefinition & { testId: TId; params: P };

function createDiffusionTest<
  const TId extends string,
  const P extends Record<string, unknown>,
>(
  testId: TId,
  params: P,
  expectation: ExpectationLike,
  options: DiffusionTestOptions = {},
): DiffusionTestDef<TId, P> {
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
  } as DiffusionTestDef<TId, P>;
}

// Read PNG IHDR width/height: 8-byte signature, 4-byte chunk length, 4-byte
// "IHDR" tag, then big-endian uint32 width and uint32 height at offsets 16/20.
function readPngDims(
  buf: Uint8Array,
): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  const sig = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!sig) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

// Shared PNG-dimension validator: asserts first output is a PNG of expected size.
// `label` lets callers identify themselves in the failure message.
function validatePngDims(
  expectedWidth: number,
  expectedHeight: number,
  label: string,
) {
  return (result: unknown): TestResult => {
    if (!Array.isArray(result) || result.length === 0) {
      return { passed: false, output: "No outputs generated" };
    }
    const out = result[0];
    if (!(out instanceof Uint8Array)) {
      return { passed: false, output: "First output is not a Uint8Array" };
    }
    const dims = readPngDims(out);
    if (!dims) {
      return { passed: false, output: "Output is not a valid PNG" };
    }
    const passed = dims.width === expectedWidth && dims.height === expectedHeight;
    return {
      passed,
      output: passed
        ? `${label} OK: ${dims.width}x${dims.height}`
        : `${label}: expected ${expectedWidth}x${expectedHeight}, got ${dims.width}x${dims.height}`,
    };
  };
}

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
// Source asset is 256x256 to match request width/height: FLUX.2 auto-resize is
// a no-op and SD 2.1 SDEdit emits source-sized output, so output is 256x256 on
// both engines.

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

// FLUX.2 ignores img_cfg_scale (in-context conditioning); SD 2.1 honors it via
// SDEdit. Schema accept + PNG size check is the strongest cross-platform
// assertion without per-engine branching.
export const diffusionImg2imgImgCfgScale = createDiffusionTest(
  "diffusion-img2img-img-cfg-scale",
  {
    prompt: "oil painting style",
    init_image: "diffusion-img2img-source-256.png",
    strength: 0.5,
    img_cfg_scale: 5.0,
    width: 256,
    height: 256,
    steps: 4,
    seed: 42,
  },
  { validation: "function", fn: validatePngDims(256, 256, "img2img PNG") },
);

export const diffusionImg2imgVsTxt2imgBaseline = createDiffusionTest(
  "diffusion-img2img-vs-txt2img-baseline",
  {
    prompt: "watercolor style",
    init_image: "diffusion-img2img-source-256.png",
    strength: 0.5,
    width: 256,
    height: 256,
    steps: 4,
    seed: 42,
  },
  // Required by TestDefinition but effectively ignored — DiffusionExecutor.img2imgVsTxt2imgBaseline gates the result.
  { validation: "type", expectedType: "array" },
  { estimatedDurationMs: 600000 },
);

export const diffusionImg2imgInvalidStrength = createDiffusionTest(
  "diffusion-img2img-invalid-strength",
  {
    prompt: "test",
    init_image: "diffusion-img2img-source-256.png",
    strength: 1.5,
    width: 256,
    height: 256,
    steps: 4,
  },
  {
    validation: "throws-error",
    // Match the field path rather than the Zod message — stable across version
    // bumps that rephrase numeric-bound messages.
    errorContains: "strength",
  },
  { estimatedDurationMs: 60000 },
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

// ---- diffusion_fa config flag ----

export const diffusionFaAccepted = createDiffusionTest(
  "diffusion-fa-loads-and-runs",
  {
    prompt: "a solid blue circle on white background",
    width: 256,
    height: 256,
    steps: 4,
    seed: 42,
  },
  { validation: "type", expectedType: "array" },
  { dependency: "diffusion-fa" },
);

export const diffusionFaDisabledAccepted = createDiffusionTest(
  "diffusion-fa-disabled-loads-and-runs",
  {
    prompt: "a solid blue circle on white background",
    width: 256,
    height: 256,
    steps: 4,
    seed: 42,
  },
  { validation: "type", expectedType: "array" },
  { dependency: "diffusion-fa-disabled" },
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
  {
    validation: "function",
    fn: validatePngDims(
      ESRGAN_SOURCE_WIDTH * ESRGAN_SCALE,
      ESRGAN_SOURCE_HEIGHT * ESRGAN_SCALE,
      `ESRGAN x${ESRGAN_SCALE}`,
    ),
  },
  { estimatedDurationMs: 600000, dependency: "diffusion-esrgan" },
);

export const diffusionStandaloneUpscalerX4 = createDiffusionTest(
  "diffusion-standalone-upscaler-x4",
  {
    image: "small-64.jpg",
    repeats: 1,
  },
  {
    validation: "function",
    fn: validatePngDims(
      STANDALONE_UPSCALER_SOURCE_WIDTH * ESRGAN_SCALE,
      STANDALONE_UPSCALER_SOURCE_HEIGHT * ESRGAN_SCALE,
      `Standalone upscaler x${ESRGAN_SCALE}`,
    ),
  },
  { estimatedDurationMs: 600000, dependency: "upscaler" },
);

export const diffusionStandaloneUpscalerBackendDevice = createDiffusionTest(
  "diffusion-standalone-upscaler-backend-device",
  {
    image: "small-64.jpg",
    repeats: 1,
  },
  { validation: "type", expectedType: "string" },
  { estimatedDurationMs: 1000, dependency: "upscaler" },
);

export const diffusionStandaloneUpscalerCpu = createDiffusionTest(
  "diffusion-standalone-upscaler-cpu",
  {
    image: "small-64.jpg",
    repeats: 1,
  },
  { validation: "type", expectedType: "string" },
  { estimatedDurationMs: 2000, dependency: "upscaler-cpu", suites: ["smoke"] },
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
  diffusionImg2imgImgCfgScale,
  diffusionImg2imgVsTxt2imgBaseline,
  diffusionImg2imgInvalidStrength,
  diffusionStreaming,
  diffusionStreamingProgress,
  diffusionStatsPresent,
  diffusionFaAccepted,
  diffusionFaDisabledAccepted,
  diffusionFusionFlux2Basic,
  diffusionEsrganUpscaleX4,
  diffusionStandaloneUpscalerX4,
  diffusionStandaloneUpscalerBackendDevice,
  diffusionStandaloneUpscalerCpu,
] as const;
