// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  sdcppConfigSchema,
  videoRequestSchema,
  videoStatsSchema,
  videoStreamRequestSchema,
  videoStreamResponseSchema,
} from "@/schemas";

type BrittleT = {
  alike: (actual: unknown, expected: unknown, msg?: string) => void;
  is: (actual: unknown, expected: unknown, msg?: string) => void;
  ok: (value: unknown, msg?: string) => void;
};

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUg==";

test("sdcppConfigSchema: accepts mode: 'video' and highNoiseDiffusionModelSrc", (t: BrittleT) => {
  const result = sdcppConfigSchema.safeParse({
    mode: "video",
    offload_to_cpu: true,
    t5XxlModelSrc: "umt5_xxl_fp16.safetensors",
    vaeModelSrc: "wan_2.1_vae.safetensors",
    highNoiseDiffusionModelSrc: "wan2.2_high_noise_fp16.safetensors",
  });
  t.is(result.success, true);
});

test("videoStatsSchema: accepts video runtime stats fields", (t: BrittleT) => {
  const result = videoStatsSchema.safeParse({
    modelLoadMs: 500,
    generationMs: 1234,
    totalGenerationMs: 1234,
    totalWallMs: 1734,
    totalSteps: 20,
    totalGenerations: 1,
    totalImages: 1,
    totalPixels: 262144,
    totalVideos: 1,
    totalVideoFrames: 5,
    width: 512,
    height: 512,
    seed: 42,
    videoFrames: 5,
    fps: 16,
  });
  t.is(result.success, true);
});

test("videoRequestSchema: accepts minimal txt2vid request", (t: BrittleT) => {
  const result = videoRequestSchema.safeParse({
    modelId: "model-1",
    mode: "txt2vid",
    prompt: "a running fox",
    video_frames: 5,
  });
  t.is(result.success, true);
});

test("videoRequestSchema: accepts optional requestId", (t: BrittleT) => {
  const result = videoRequestSchema.safeParse({
    modelId: "model-1",
    requestId: "video-request-1",
    mode: "txt2vid",
    prompt: "a running fox",
    video_frames: 5,
  });
  t.is(result.success, true);
});

test("videoRequestSchema: validates video_frames, fps, moe_boundary, and base64 inputs", (t: BrittleT) => {
  t.is(
    videoRequestSchema.safeParse({
      modelId: "model-1",
      mode: "txt2vid",
      prompt: "a fox",
      video_frames: 6,
    }).success,
    false,
    "video_frames must satisfy (4*k + 1)",
  );

  t.is(
    videoRequestSchema.safeParse({
      modelId: "model-1",
      mode: "txt2vid",
      prompt: "a fox",
      fps: 0,
    }).success,
    false,
    "fps must be > 0",
  );

  t.is(
    videoRequestSchema.safeParse({
      modelId: "model-1",
      mode: "txt2vid",
      prompt: "a fox",
      moe_boundary: 2,
    }).success,
    false,
    "moe_boundary must be in [0, 1]",
  );

  t.is(
    videoRequestSchema.safeParse({
      modelId: "model-1",
      mode: "txt2vid",
      prompt: "a fox",
      control_frames: ["not valid base64!!!"],
    }).success,
    false,
    "control_frames entries must be valid base64",
  );

  t.is(
    videoRequestSchema.safeParse({
      modelId: "model-1",
      mode: "txt2vid",
      prompt: "a fox",
      control_frames: [],
    }).success,
    false,
    "control_frames must reject empty arrays",
  );
});

test("videoStreamRequestSchema: rejects unsupported modes", (t: BrittleT) => {
  const result = videoStreamRequestSchema.safeParse({
    type: "videoStream",
    modelId: "model-1",
    mode: "img2vid",
    prompt: "animate this frame",
  });
  t.is(result.success, false);
});

test("videoStreamResponseSchema: accepts progress, output, and final stats chunks", (t: BrittleT) => {
  t.is(
    videoStreamResponseSchema.safeParse({
      type: "videoStream",
      step: 1,
      totalSteps: 5,
      elapsedMs: 200,
    }).success,
    true,
  );

  t.is(
    videoStreamResponseSchema.safeParse({
      type: "videoStream",
      data: PNG_B64,
      outputIndex: 0,
    }).success,
    true,
  );

  t.is(
    videoStreamResponseSchema.safeParse({
      type: "videoStream",
      done: true,
      stats: {
        generationMs: 1234,
        totalVideos: 1,
        totalVideoFrames: 5,
        videoFrames: 5,
        fps: 16,
      },
    }).success,
    true,
  );
});
