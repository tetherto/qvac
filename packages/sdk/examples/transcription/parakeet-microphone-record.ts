import {
  loadModel,
  unloadModel,
  transcribeStream,
  PARAKEET_TDT_ENCODER_FP32,
  PARAKEET_TDT_ENCODER_DATA_FP32,
  PARAKEET_TDT_DECODER_FP32,
  PARAKEET_TDT_VOCAB,
  PARAKEET_TDT_PREPROCESSOR_FP32,
} from "@qvac/sdk";
import { spawn, spawnSync } from "child_process";
import { platform } from "os";

function checkFFmpeg() {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new Error("FFmpeg is required but not found in PATH.");
  }
}

function getAudioDevice(): string {
  switch (platform()) {
    case "darwin":
      return ":0";
    case "linux":
      return "default";
    case "win32":
      // Change as per your system
      return "audio=@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{58C07110-A4FD-4FF8-BA10-5A3C14389F71}";
    default:
      throw new Error(`Unsupported platform: ${platform()}`);
  }
}

function getAudioInputArgs(): string[] {
  switch (platform()) {
    case "darwin":
      return ["-f", "avfoundation", "-i", getAudioDevice()];
    case "linux":
      return ["-f", "pulse", "-i", getAudioDevice()];
    case "win32":
      return ["-f", "dshow", "-i", getAudioDevice()];
    default:
      throw new Error(`Unsupported platform: ${platform()}`);
  }
}

checkFFmpeg();

console.log("Loading Parakeet model...");
const modelId = await loadModel({
  modelSrc: PARAKEET_TDT_ENCODER_FP32,
  modelType: "parakeet",
  modelConfig: {
    parakeetEncoderSrc: PARAKEET_TDT_ENCODER_FP32,
    parakeetEncoderDataSrc: PARAKEET_TDT_ENCODER_DATA_FP32,
    parakeetDecoderSrc: PARAKEET_TDT_DECODER_FP32,
    parakeetVocabSrc: PARAKEET_TDT_VOCAB,
    parakeetPreprocessorSrc: PARAKEET_TDT_PREPROCESSOR_FP32,
  },
  onProgress: (p) => console.log(`Download: ${p.percentage.toFixed(1)}%`),
});
console.log("Model loaded. Speak into your microphone (Ctrl+C to stop):\n");

const ffmpeg = spawn(
  "ffmpeg",
  [...getAudioInputArgs(), "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", "-f", "s16le", "pipe:1"],
  { stdio: ["ignore", "pipe", "ignore"] },
);

const CHUNK_SIZE = 96000; // ~3s of 16kHz 16-bit mono
let buffer = Buffer.alloc(0);
let processing = false;

ffmpeg.stdout.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);

  if (buffer.length >= CHUNK_SIZE && !processing) {
    const audioChunk = buffer.subarray(0, CHUNK_SIZE);
    buffer = buffer.subarray(CHUNK_SIZE);
    processing = true;

    void (async () => {
      try {
        for await (const text of transcribeStream({ modelId, audioChunk })) {
          if (text.trim() && !text.includes("[No speech detected]")) {
            process.stdout.write(text);
          }
        }
      } catch (err) {
        console.error("Transcription error:", err instanceof Error ? err.message : err);
      } finally {
        processing = false;
      }
    })();
  }
});

async function cleanup() {
  console.log("\n\nStopping...");
  ffmpeg.kill();
  await unloadModel({ modelId });
  console.log("Done.");
}

process.on("SIGINT", () => void cleanup());
process.on("SIGTERM", () => void cleanup());
