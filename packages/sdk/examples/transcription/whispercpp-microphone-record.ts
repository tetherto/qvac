/**
 * Microphone → Whisper streaming transcription with native VAD.
 *
 * Usage: bun run examples/transcription/whispercpp-microphone-record.ts
 *
 * Speak into your mic; transcriptions appear automatically when you pause.
 * Press Ctrl+C to quit.
 *
 * Requirements: FFmpeg installed, microphone access.
 */
import {
  loadModel,
  unloadModel,
  transcribeStream,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
} from "@qvac/sdk";
import { spawnSync } from "child_process";
import { startMicrophone } from "../audio/mic-input";

const SAMPLE_RATE = 16000;

// ── Main ──

try {
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (r.error || r.status !== 0) throw new Error("FFmpeg not found");
} catch {
  console.error("FFmpeg is required. Install it and try again.");
  process.exit(1);
}

console.log("Loading model (whisper-tiny + Silero VAD)...");
const modelId = await loadModel({
  modelSrc: WHISPER_TINY,
  modelType: "whisper",
  modelConfig: {
    vadModelSrc: VAD_SILERO_5_1_2,
    audio_format: "f32le",
    strategy: "greedy",
    n_threads: 4,
    language: "en",
    no_timestamps: true,
    suppress_blank: true,
    suppress_nst: true,
    temperature: 0.0,
    vad_params: {
      threshold: 0.6,
      min_speech_duration_ms: 250,
      min_silence_duration_ms: 300,
      max_speech_duration_s: 15.0,
      speech_pad_ms: 100,
    },
  },
});
console.log("Model loaded.\n");

const ffmpeg = startMicrophone({
  sampleRate: SAMPLE_RATE,
  format: "f32le",
});

const session = await transcribeStream({ modelId });

ffmpeg.stdout.on("data", (chunk: Buffer) => session.write(chunk));

console.log("Listening... speak and pause to see transcriptions.\n");

for await (const text of session) {
  console.log(`> ${text.trim()}`);
}

async function cleanup() {
  console.log("\n\nStopping...");
  ffmpeg.kill();
  await unloadModel({ modelId });
  console.log("Done.");
}

process.on("SIGINT", () => void cleanup());
process.on("SIGTERM", () => void cleanup());
