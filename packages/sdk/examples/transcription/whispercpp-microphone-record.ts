/**
 * Microphone → Whisper streaming transcription with native VAD.
 *
 * Usage: bun run examples/transcription/whispercpp-microphone-record.ts
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
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
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

const ffmpeg = spawn(
  "ffmpeg",
  [
    ...getAudioInputArgs(),
    "-ar", String(SAMPLE_RATE),
    "-ac", "1",
    "-sample_fmt", "flt",
    "-f", "f32le",
    "pipe:1",
  ],
  { stdio: ["ignore", "pipe", "ignore"] },
);
if (!ffmpeg.stdout) throw new Error("Failed to open microphone");

try {
  const session = await transcribeStream({ modelId });

  ffmpeg.stdout.on("data", (chunk: Buffer) => session.write(chunk));

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
} finally {
  console.log("\nUnloading model...");
  await unloadModel({ modelId });
  // Force exit — stdin/stream handles may keep the event loop alive
  process.exit(0);
}

