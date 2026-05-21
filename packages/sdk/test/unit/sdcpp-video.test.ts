// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  sdcppConfigSchema,
  videoRequestSchema,
  videoStreamRequestSchema,
  videoStreamResponseSchema,
  videoStatsSchema,
  ModelType,
} from "@/schemas";
import {
  registerModel,
  unregisterModel,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import { video as videoOp } from "@/server/bare/plugins/sdcpp-generation/ops/video";

type BrittleT = {
  alike: (actual: unknown, expected: unknown, msg?: string) => void;
  is: (actual: unknown, expected: unknown, msg?: string) => void;
  ok: (value: unknown, msg?: string) => void;
};

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUg==";
const JPEG_B64 = "/9j/4AAQSkZJRgABAQEASABIAAA=";

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

test("videoRequestSchema: txt2vid rejects init_image and end_image", (t: BrittleT) => {
  const result = videoRequestSchema.safeParse({
    modelId: "model-1",
    mode: "txt2vid",
    prompt: "a running fox",
    init_image: PNG_B64,
    end_image: JPEG_B64,
  });
  t.is(result.success, false);
  if (!result.success) {
    const messages = result.error.issues.map((issue) => issue.message).join(" | ");
    t.ok(messages.includes("txt2vid does not accept init_image"));
    t.ok(messages.includes("txt2vid does not accept end_image"));
  }
});

test("videoRequestSchema: img2vid requires init_image and rejects end_image", (t: BrittleT) => {
  const missingInit = videoRequestSchema.safeParse({
    modelId: "model-1",
    mode: "img2vid",
    prompt: "animate this frame",
  });
  t.is(missingInit.success, false);

  const withEndImage = videoRequestSchema.safeParse({
    modelId: "model-1",
    mode: "img2vid",
    prompt: "animate this frame",
    init_image: PNG_B64,
    end_image: JPEG_B64,
  });
  t.is(withEndImage.success, false);
});

test("videoRequestSchema: flf2vid requires both init_image and end_image", (t: BrittleT) => {
  const missingInit = videoRequestSchema.safeParse({
    modelId: "model-1",
    mode: "flf2vid",
    prompt: "interpolate the scene",
    end_image: JPEG_B64,
  });
  t.is(missingInit.success, false);

  const missingEnd = videoRequestSchema.safeParse({
    modelId: "model-1",
    mode: "flf2vid",
    prompt: "interpolate the scene",
    init_image: PNG_B64,
  });
  t.is(missingEnd.success, false);

  const valid = videoRequestSchema.safeParse({
    modelId: "model-1",
    mode: "flf2vid",
    prompt: "interpolate the scene",
    init_image: PNG_B64,
    end_image: JPEG_B64,
  });
  t.is(valid.success, true);
});

test("videoRequestSchema: validates video_frames, fps, moe_boundary, and base64 inputs", (t: BrittleT) => {
  t.is(videoRequestSchema.safeParse({
    modelId: "model-1",
    mode: "txt2vid",
    prompt: "a fox",
    video_frames: 6,
  }).success, false, "video_frames must satisfy (4*k + 1)");

  t.is(videoRequestSchema.safeParse({
    modelId: "model-1",
    mode: "txt2vid",
    prompt: "a fox",
    fps: 0,
  }).success, false, "fps must be > 0");

  t.is(videoRequestSchema.safeParse({
    modelId: "model-1",
    mode: "txt2vid",
    prompt: "a fox",
    moe_boundary: 2,
  }).success, false, "moe_boundary must be in [0, 1]");

  t.is(videoRequestSchema.safeParse({
    modelId: "model-1",
    mode: "img2vid",
    prompt: "a fox",
    init_image: "not valid base64!!!",
  }).success, false, "init_image must be valid base64");

  t.is(videoRequestSchema.safeParse({
    modelId: "model-1",
    mode: "img2vid",
    prompt: "a fox",
    init_image: PNG_B64,
    control_frames: [],
  }).success, false, "control_frames must reject empty arrays");
});

test("videoStreamRequestSchema: preserves video-mode refinements", (t: BrittleT) => {
  const result = videoStreamRequestSchema.safeParse({
    type: "videoStream",
    modelId: "model-1",
    mode: "img2vid",
    prompt: "animate this frame",
  });
  t.is(result.success, false);
});

test("videoStreamResponseSchema: accepts progress, output, and final stats chunks", (t: BrittleT) => {
  t.is(videoStreamResponseSchema.safeParse({
    type: "videoStream",
    step: 1,
    totalSteps: 5,
    elapsedMs: 200,
  }).success, true);

  t.is(videoStreamResponseSchema.safeParse({
    type: "videoStream",
    data: PNG_B64,
    outputIndex: 0,
  }).success, true);

  t.is(videoStreamResponseSchema.safeParse({
    type: "videoStream",
    done: true,
    stats: {
      generationMs: 1234,
      totalVideos: 1,
      totalVideoFrames: 5,
      videoFrames: 5,
      fps: 16,
    },
  }).success, true);
});

async function withRegisteredVideoModel<T>(
  runImpl: (params: unknown) => Promise<unknown>,
  body: (modelId: string) => Promise<T>,
): Promise<T> {
  const modelId = `test-video-${Math.random().toString(36).slice(2, 10)}`;
  const fakeModel = {
    load: async function () {},
    run: runImpl,
  } as unknown as AnyModel;

  try {
    registerModel(modelId, {
      model: fakeModel,
      path: "/tmp/video-model.safetensors",
      config: {},
      modelType: ModelType.sdcppGeneration,
    });
    return await body(modelId);
  } finally {
    unregisterModel(modelId);
  }
}

test("video op: decodes base64 inputs, forwards mode, and emits stream responses", async function (t: BrittleT) {
  let observed: Record<string, unknown> | undefined;

  await withRegisteredVideoModel(
    async function (params: unknown) {
      observed = params as Record<string, unknown>;
      return {
        stats: {
          generationMs: 900,
          totalVideos: 1,
          totalVideoFrames: 5,
          videoFrames: 5,
          fps: 16,
        },
        iterate: async function* () {
          yield JSON.stringify({ step: 2, total: 5, elapsed_ms: 250 });
          yield new Uint8Array([82, 73, 70, 70]);
        },
      };
    },
    async (modelId) => {
      const chunks = [];
      for await (const chunk of videoOp({
        modelId,
        mode: "flf2vid",
        prompt: "interpolate the scene",
        init_image: PNG_B64,
        end_image: JPEG_B64,
        control_frames: [PNG_B64, JPEG_B64],
        video_frames: 5,
        fps: 16,
      })) {
        chunks.push(chunk);
      }

      t.ok(observed, "model.run was called");
      t.is(observed?.["mode"], "flf2vid");
      t.ok(observed?.["init_image"] instanceof Uint8Array);
      t.ok(observed?.["end_image"] instanceof Uint8Array);
      t.ok(Array.isArray(observed?.["control_frames"]));
      t.is((observed?.["control_frames"] as Uint8Array[]).length, 2);

      t.alike(chunks[0], {
        type: "videoStream",
        step: 2,
        totalSteps: 5,
        elapsedMs: 250,
      });
      t.is(chunks[1]?.type, "videoStream");
      t.is(chunks[1]?.outputIndex, 0);
      t.is(chunks[2]?.done, true);
      t.alike(chunks[2]?.stats, {
        generationMs: 900,
        totalVideos: 1,
        totalVideoFrames: 5,
        videoFrames: 5,
        fps: 16,
      });
    },
  );
});
