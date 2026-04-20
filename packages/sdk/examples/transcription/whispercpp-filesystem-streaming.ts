/**
 * Test script: pipes a WAV file through transcribeStream to verify
 * the bidirectional streaming + addon processing works end-to-end.
 *
 * Usage: bun run examples/transcription/whispercpp-filesystem-streaming.ts
 *
 * Uses FFmpeg to convert the WAV to raw f32le and streams chunks
 * through the duplex RPC session to the whisper addon.
 *
 * This example requires a test audio file (default: examples/audio/diarization-sample-16k.wav).
 * Sample audio files are available in the QVAC source repository, but not included in the published npm package.
 * Set SAMPLE_FILE to a custom WAV, or download the default audio into examples/audio/:
 *   https://github.com/tetherto/qvac/blob/main/packages/sdk/examples/audio/diarization-sample-16k.wav
 */
import {
  loadModel,
  unloadModel,
  transcribeStream,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
} from "@qvac/sdk";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAMPLE_FILE = path.resolve(
  __dirname,
  "../audio/diarization-sample-16k.wav",
);

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 4; // f32le
const CHUNK_SIZE = Math.floor(0.1 * SAMPLE_RATE) * BYTES_PER_SAMPLE; // 100ms chunks

try {
  console.log("=== transcribeStream file test ===");
  console.log(`File: ${SAMPLE_FILE}`);
  console.log(`Chunk size: ${CHUNK_SIZE} bytes (100ms)\n`);

  console.log("Loading model...");
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
        min_silence_duration_ms: 500,
        max_speech_duration_s: 15.0,
        speech_pad_ms: 200,
      },
    },
  });
  console.log(`Model loaded: ${modelId}\n`);

  console.log("Opening live session...");
  const session = await transcribeStream({ modelId });
  console.log("Session open. Streaming audio...\n");

  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-i", SAMPLE_FILE,
      "-ar", String(SAMPLE_RATE),
      "-ac", "1",
      "-sample_fmt", "flt",
      "-f", "f32le",
      "pipe:1",
    ],
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
    console.log(
      `Audio streamed: ${totalBytes} bytes (~${durationSec.toFixed(1)}s)`,
    );
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
} catch (error) {
  console.error("Error:", error);
  process.exit(1);
}
