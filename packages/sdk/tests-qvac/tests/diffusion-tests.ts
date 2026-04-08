// Diffusion test definitions
import type { TestDefinition } from "@tetherto/qvac-test-suite";

const createDiffusionTest = (
  testId: string,
  params: Record<string, unknown>,
  expectation:
    | { validation: "type"; expectedType: "string" | "number" | "array" }
    | { validation: "throws-error"; errorContains: string },
  estimatedDurationMs: number = 300000,
): TestDefinition => ({
  testId,
  params,
  expectation,
  metadata: {
    category: "diffusion",
    dependency: "diffusion",
    estimatedDurationMs,
  },
});

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
  600000,
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
  600000,
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
  60000,
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
  diffusionStreaming,
  diffusionStreamingProgress,
  diffusionStatsPresent,
  diffusionEmptyPrompt,
];
