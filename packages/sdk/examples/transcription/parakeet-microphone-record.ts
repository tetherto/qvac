/**
 * Microphone → Parakeet streaming transcription.
 *
 * Usage: bun run examples/transcription/parakeet-microphone-record.ts
 *
 * Speak into your mic; transcriptions appear automatically when you pause.
 * Press Enter or Ctrl+C to quit.
 *
 * Requirements: FFmpeg installed, microphone access.
 */
import {
  loadModel,
  unloadModel,
  transcribeStream,
  PARAKEET_ENCODER_FP32,
  PARAKEET_ENCODER_DATA_FP32,
  PARAKEET_DECODER_FP32,
  PARAKEET_VOCAB,
  PARAKEET_PREPROCESSOR_FP32,
} from "@qvac/sdk";
import { spawn, spawnSync } from "child_process";
import { platform } from "os";

const SAMPLE_RATE = 16000;

function getAudioInputArgs(): string[] {
  switch (platform()) {
    case "darwin":
      return ["-f", "avfoundation", "-i", ":0"];
    case "win32":
      return [
        "-f",
        "dshow",
        "-i",
        "audio=@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{58C07110-A4FD-4FF8-BA10-5A3C14389F71}",
      ];
    case "linux":
      return ["-f", "pulse", "-i", "default"];
    default:
      throw new Error(`Unsupported platform: ${platform()}`);
  }
}

// ── Main ──

try {
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (r.error || r.status !== 0) throw new Error("FFmpeg not found");
} catch {
  console.error("FFmpeg is required. Install it and try again.");
  process.exit(1);
}

console.log("Loading Parakeet model...");
const modelId = await loadModel({
  modelSrc: PARAKEET_ENCODER_FP32,
  modelType: "parakeet",
  modelConfig: {
    parakeetEncoderSrc: PARAKEET_ENCODER_FP32,
    parakeetEncoderDataSrc: PARAKEET_ENCODER_DATA_FP32,
    parakeetDecoderSrc: PARAKEET_DECODER_FP32,
    parakeetVocabSrc: PARAKEET_VOCAB,
    parakeetPreprocessorSrc: PARAKEET_PREPROCESSOR_FP32,
  },
  onProgress: (p) => console.log(`  Download: ${p.percentage.toFixed(1)}%`),
});
console.log("Model loaded.\n");

const ffmpeg = spawn(
  "ffmpeg",
  [...getAudioInputArgs(), "-ar", String(SAMPLE_RATE), "-ac", "1", "-sample_fmt", "flt", "-f", "f32le", "pipe:1"],
  { stdio: ["ignore", "pipe", "ignore"] },
);
if (!ffmpeg.stdout) throw new Error("Failed to open microphone");

const session = await transcribeStream({ modelId });

ffmpeg.stdout.on("data", (chunk: Buffer) => session.write(chunk));
ffmpeg.on("close", () => session.end());

console.log("Calibrating microphone (2 seconds, stay quiet)...");
await new Promise((resolve) => setTimeout(resolve, 2500));
console.log("Listening... speak and pause to see transcriptions.");
console.log("Press Enter to stop.\n");

const done = (async () => {
  for await (const text of session) {
    console.log(`> ${text.trim()}`);
  }
})();

process.stdin.resume();
process.stdin.setEncoding("utf8");
await new Promise<void>((resolve) => {
  const onData = (data: string) => {
    if (data.includes("\n") || data.includes("\r")) {
      process.stdin.off("data", onData);
      resolve();
    }
  };
  process.stdin.on("data", onData);
});

ffmpeg.kill();
session.end();
await done;

console.log("\nUnloading model...");
await unloadModel({ modelId });
process.exit(0);
