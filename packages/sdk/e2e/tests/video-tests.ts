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

function validateTxt2vidSmoke(result: unknown): TestResult {
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

  if (summary.stats?.videoFrames !== 5) {
    return {
      passed: false,
      output: `Expected stats.videoFrames=5, got ${summary.stats?.videoFrames ?? "missing"}`,
    };
  }

  if (summary.stats?.fps !== 16) {
    return {
      passed: false,
      output: `Expected stats.fps=16, got ${summary.stats?.fps ?? "missing"}`,
    };
  }

  return {
    passed: true,
    output: `Generated AVI (${summary.outputs[0]!.length} bytes) with ${summary.stats.videoFrames} frames @ ${summary.stats.fps} fps`,
  };
}

export const videoTxt2vidSmoke: TestDefinition = {
  testId: "video-basic-txt2vid",
  params: {
    prompt: "a red ball bouncing on a white floor",
    video_frames: 5,
    fps: 16,
    steps: 1,
    seed: 42,
  },
  expectation: { validation: "function", fn: validateTxt2vidSmoke },
  suites: ["smoke"],
  metadata: {
    category: "video",
    dependency: "video",
    estimatedDurationMs: 180000,
  },
};

export const videoTests = [videoTxt2vidSmoke];
