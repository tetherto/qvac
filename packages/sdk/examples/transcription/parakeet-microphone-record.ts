/**
 * Microphone → Parakeet transcription using chunked `transcribe` calls.
 *
 * Usage: bun run examples/transcription/parakeet-microphone-record.ts
 *
 * Captures 3-second audio chunks from the microphone and sends each to the
 * batch `transcribe` API. Press Ctrl+C to quit.
 *
 * Requirements: FFmpeg installed, microphone access.
 */
import {
  loadModel,
  unloadModel,
  transcribe,
  PARAKEET_TDT_ENCODER_FP32,
  PARAKEET_TDT_DECODER_FP32,
  PARAKEET_TDT_VOCAB,
  PARAKEET_TDT_PREPROCESSOR_FP32,
} from "@qvac/sdk";
import { spawnSync } from "child_process";
import { startMicrophone } from "../audio/mic-input";

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // s16le
const CHUNK_DURATION_S = 3;
const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_DURATION_S;

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
  modelSrc: PARAKEET_TDT_ENCODER_FP32,
  modelType: "parakeet",
  modelConfig: {
    parakeetEncoderSrc: PARAKEET_TDT_ENCODER_FP32,
    parakeetDecoderSrc: PARAKEET_TDT_DECODER_FP32,
    parakeetVocabSrc: PARAKEET_TDT_VOCAB,
    parakeetPreprocessorSrc: PARAKEET_TDT_PREPROCESSOR_FP32,
  },
  onProgress: (p) => console.log(`Download: ${p.percentage.toFixed(1)}%`),
});
console.log("Model loaded.\n");

const ffmpeg = startMicrophone({
  sampleRate: SAMPLE_RATE,
  format: "s16le",
});

let buffer = Buffer.alloc(0);
let processing = false;

console.log("Listening... speak and pause to see transcriptions.\n");

ffmpeg.stdout.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);

  if (buffer.length >= CHUNK_SIZE && !processing) {
    const audioChunk = buffer.subarray(0, CHUNK_SIZE);
    buffer = buffer.subarray(CHUNK_SIZE);
    processing = true;

    void (async () => {
      try {
        const text = await transcribe({ modelId, audioChunk });
        if (text.trim() && !text.includes("[No speech detected]")) {
          console.log(`> ${text.trim()}`);
        }
      } catch (err) {
        console.error(
          "Transcription error:",
          err instanceof Error ? err.message : err,
        );
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
