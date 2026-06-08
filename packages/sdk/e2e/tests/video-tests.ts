import type { TestDefinition, TestResult } from "@tetherto/qvac-test-suite";

interface VideoExecutionSummary {
  outputs: Uint8Array[];
  stats?: {
    totalVideos?: number;
    totalVideoFrames?: number;
    videoFrames?: number;
    fps?: number;
  };
}

function validateVideoSmoke(
  result: unknown,
  expected: { frames: number; fps: number; label: string },
): TestResult {
  if (!result || typeof result !== "object") {
    return { passed: false, output: "Missing video execution summary" };
  }

  const summary = result as VideoExecutionSummary;
  if (!Array.isArray(summary.outputs) || summary.outputs.length !== 1) {
    return {
      passed: false,
      output: `Expected exactly one AVI output, got ${summary.outputs?.length ?? 0}`,
    };
  }

  const buffer = summary.outputs[0]!;
  const hasRiffHeader =
    buffer.length >= 12 &&
    buffer[0] === 82 &&
    buffer[1] === 73 &&
    buffer[2] === 70 &&
    buffer[3] === 70 &&
    buffer[8] === 65 &&
    buffer[9] === 86 &&
    buffer[10] === 73 &&
    buffer[11] === 32;

  if (!hasRiffHeader) {
    return { passed: false, output: "Output buffer is not an AVI RIFF container" };
  }

  if (summary.stats?.videoFrames !== expected.frames) {
    return {
      passed: false,
      output: `Expected stats.videoFrames=${expected.frames}, got ${summary.stats?.videoFrames ?? "missing"}`,
    };
  }

  if (summary.stats?.fps !== expected.fps) {
    return {
      passed: false,
      output: `Expected stats.fps=${expected.fps}, got ${summary.stats?.fps ?? "missing"}`,
    };
  }

  return {
    passed: true,
    output: `${expected.label} generated AVI (${summary.outputs[0]!.length} bytes) with ${summary.stats.videoFrames} frames @ ${summary.stats.fps} fps`,
  };
}

function validateTxt2vidSmoke(result: unknown): TestResult {
  return validateVideoSmoke(result, { frames: 5, fps: 16, label: "txt2vid" });
}

function validateImg2vidSmoke(result: unknown): TestResult {
  return validateVideoSmoke(result, { frames: 5, fps: 16, label: "img2vid" });
}

export const videoTxt2vidSmoke: TestDefinition = {
  testId: "video-basic-txt2vid",
  params: {
    prompt: "a red ball bouncing on a white floor",
    video_frames: 5,
    fps: 16,
    steps: 1,
    seed: 42,
    width: 416,
    height: 240,
  },
  expectation: { validation: "function", fn: validateTxt2vidSmoke },
  suites: ["smoke"],
  metadata: {
    category: "video",
    dependency: "video",
    estimatedDurationMs: 180000,
  },
};

export const videoImg2vidSmoke: TestDefinition = {
  testId: "video-basic-img2vid",
  params: {
    mode: "img2vid",
    prompt: "a scientist walking through a sunlit laboratory",
    init_image: "diffusion-img2img-source-256.png",
    video_frames: 5,
    fps: 16,
    steps: 2,
    seed: 42,
    strength: 0.85,
    flow_shift: 3.0,
    cfg_scale: 6.0,
    vae_tiling: true,
  },
  expectation: { validation: "function", fn: validateImg2vidSmoke },
  suites: ["smoke"],
  metadata: {
    category: "video",
    dependency: "video-img2vid",
    estimatedDurationMs: 300000,
  },
};

export const videoTests = [videoTxt2vidSmoke, videoImg2vidSmoke];
