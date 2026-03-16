// Generation (diffusion) test definitions
import type { TestDefinition } from "@tetherto/qvac-test-suite";

const createGenerationTest = (
  testId: string,
  params: Record<string, unknown>,
  expectation:
    | { validation: "type"; expectedType: "string" | "number" | "array" }
    | { validation: "throws-error"; errorContains: string },
  estimatedDurationMs: number = 120000,
): TestDefinition => ({
  testId,
  params,
  expectation,
  metadata: {
    category: "generation",
    dependency: "diffusion",
    estimatedDurationMs,
  },
});

// ---- txt2img ----

export const generationBasicTxt2img = createGenerationTest(
  "generation-basic-txt2img",
  {
    prompt: "a solid red square on white background",
    width: 256,
    height: 256,
    steps: 4,
    seed: 42,
  },
  { validation: "type", expectedType: "array" },
);

export const generationDefaultSize = createGenerationTest(
  "generation-default-size",
  {
    prompt: "a blue circle",
    width: 256,
    height: 256,
    steps: 2,
    seed: 42,
  },
  { validation: "type", expectedType: "array" },
);

export const generationNegativePrompt = createGenerationTest(
  "generation-negative-prompt",
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

export const generationCfgScale = createGenerationTest(
  "generation-cfg-scale",
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

export const generationSamplerEulerA = createGenerationTest(
  "generation-sampler-euler-a",
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

export const generationSamplerHeun = createGenerationTest(
  "generation-sampler-heun",
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

export const generationSchedulerKarras = createGenerationTest(
  "generation-scheduler-karras",
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

export const generationSeedReproducibility = createGenerationTest(
  "generation-seed-reproducibility",
  {
    prompt: "a red triangle",
    width: 256,
    height: 256,
    steps: 4,
    seed: 12345,
    verifySeedReproducibility: true,
  },
  { validation: "type", expectedType: "string" },
  240000,
);

export const generationBatchCount = createGenerationTest(
  "generation-batch-count",
  {
    prompt: "a simple shape",
    width: 256,
    height: 256,
    steps: 4,
    batch_count: 2,
    seed: 42,
  },
  { validation: "type", expectedType: "array" },
  240000,
);

// ---- streaming ----

export const generationStreaming = createGenerationTest(
  "generation-streaming",
  {
    prompt: "a yellow star",
    width: 256,
    height: 256,
    steps: 4,
    seed: 42,
    stream: true,
  },
  { validation: "type", expectedType: "array" },
);

export const generationStreamingProgress = createGenerationTest(
  "generation-streaming-progress",
  {
    prompt: "a purple diamond",
    width: 256,
    height: 256,
    steps: 4,
    seed: 42,
    stream: true,
    verifyProgress: true,
  },
  { validation: "type", expectedType: "string" },
);

// ---- img2img ----

export const generationImg2img = createGenerationTest(
  "generation-img2img",
  {
    prompt: "watercolor painting style",
    width: 256,
    height: 256,
    steps: 4,
    strength: 0.75,
    seed: 42,
    initImageFileName: "elephant.jpg",
  },
  { validation: "type", expectedType: "array" },
);

export const generationImg2imgLowStrength = createGenerationTest(
  "generation-img2img-low-strength",
  {
    prompt: "oil painting style",
    width: 256,
    height: 256,
    steps: 4,
    strength: 0.3,
    seed: 42,
    initImageFileName: "elephant.jpg",
  },
  { validation: "type", expectedType: "array" },
);

// ---- stats ----

export const generationStatsPresent = createGenerationTest(
  "generation-stats-present",
  {
    prompt: "a white circle on black background",
    width: 256,
    height: 256,
    steps: 4,
    seed: 42,
    verifyStats: true,
  },
  { validation: "type", expectedType: "string" },
);

// ---- error cases ----

export const generationEmptyPrompt = createGenerationTest(
  "generation-empty-prompt",
  {
    prompt: "",
    width: 256,
    height: 256,
    steps: 4,
  },
  { validation: "type", expectedType: "array" },
  60000,
);

export const generationTests = [
  generationBasicTxt2img,
  generationDefaultSize,
  generationNegativePrompt,
  generationCfgScale,
  generationSamplerEulerA,
  generationSamplerHeun,
  generationSchedulerKarras,
  generationSeedReproducibility,
  generationBatchCount,
  generationStreaming,
  generationStreamingProgress,
  generationImg2img,
  generationImg2imgLowStrength,
  generationStatsPresent,
  generationEmptyPrompt,
];
