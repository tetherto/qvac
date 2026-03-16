/**
 * Test script: pipes a WAV file through transcribeStream to verify
 * streaming speech segmentation + Parakeet transcription end-to-end.
 *
 * Usage: bun run examples/transcription/test-transcribe-live-parakeet.ts
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
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAMPLE_FILE = path.resolve(
  __dirname,
  "../../../qvac-lib-infer-parakeet/examples/samples/diarization-sample-16k.wav",
);

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 4; // f32le
const CHUNK_SIZE = Math.floor(0.1 * SAMPLE_RATE) * BYTES_PER_SAMPLE; // 100ms chunks

console.log("=== transcribeStream Parakeet file test ===");
console.log(`File: ${SAMPLE_FILE}`);
console.log(`Chunk size: ${CHUNK_SIZE} bytes (100ms)\n`);

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
console.log(`Model loaded: ${modelId}\n`);

console.log("Opening live session...");
const session = await transcribeStream({ modelId });
console.log("Session open. Streaming audio...\n");

const ffmpeg = spawn(
  "ffmpeg",
  ["-i", SAMPLE_FILE, "-ar", String(SAMPLE_RATE), "-ac", "1", "-sample_fmt", "flt", "-f", "f32le", "pipe:1"],
  { stdio: ["ignore", "pipe", "ignore"] },
);

let totalBytes = 0;

ffmpeg.stdout.on("data", (raw: Buffer) => {
  for (let offset = 0; offset < raw.length; offset += CHUNK_SIZE) {
    const chunk = raw.subarray(offset, offset + CHUNK_SIZE);
    session.write(chunk);
    totalBytes += chunk.length;
  }
});

ffmpeg.on("close", () => {
  const durationSec = totalBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE);
  console.log(`Audio streamed: ${totalBytes} bytes (~${durationSec.toFixed(1)}s)`);
  console.log("Waiting for transcription...\n");
  session.end();
});

const segments: string[] = [];
for await (const text of session) {
  segments.push(text.trim());
  console.log(`  [${segments.length}] ${text.trim()}`);
}

console.log("\n=== Results ===");
console.log(`Segments: ${segments.length}`);
if (segments.length > 0) {
  console.log(`Transcript: ${segments.join(" ")}`);
} else {
  console.log("WARNING: No transcription segments received!");
}

console.log("\nUnloading model...");
await unloadModel({ modelId });
console.log("Done.");
process.exit(0);
