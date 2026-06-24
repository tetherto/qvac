/**
 * Sortformer v2.1 streaming diarization via duplex `transcribeStream` + AOSC.
 *
 * Usage:
 *   bun run examples/transcription/parakeet-sortformer-streaming.ts <wav-file> [sortformer-gguf]
 *
 * Streams 16 kHz mono s16le audio in real-time-paced chunks (required for parakeet
 * duplex streaming). Loads v2.1 with AOSC knobs in `modelConfig`. Omit the model
 * argument to use `PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0`.
 *
 * For offline batch diarization (Sortformer + TDT), see `parakeet-sortformer.ts`.
 */
import {
  loadModel,
  unloadModel,
  transcribeStream,
  PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0,
  type LoadModelOptions,
} from "@qvac/sdk";
import { spawn } from "child_process";

const SAMPLE_RATE = 16000;
const BYTES_PER_S16_SAMPLE = 2;
const STREAM_CHUNK_MS = 2000;

/** NeMo-port AOSC defaults for v2.1 Sortformer (`parakeet.model_variant` in GGUF). */
const SORTFORMER_V21_AOSC_LOAD_CONFIG = {
  streaming: true,
  streamingChunkMs: 2000,
  streamingChunkRightContextMs: 560,
  streamingSpkCacheEnable: true,
  streamingSpkCacheLen: 188,
  streamingFifoLen: 188,
  streamingChunkLeftContextMs: 80,
  streamingSpkCacheUpdatePeriod: 144,
} as const;

const args = process.argv.slice(2);

if (!args[0]) {
  console.error(
    "Usage: bun run examples/transcription/parakeet-sortformer-streaming.ts <wav-file-path> [sortformer-gguf]",
  );
  console.error(
    "\nDefaults to the v2.1 q8_0 registry model (PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0).",
  );
  process.exit(1);
}

const audioFilePath = args[0];
const sortformerOverride = args[1];
const chunkBytes =
  Math.floor((STREAM_CHUNK_MS / 1000) * SAMPLE_RATE) * BYTES_PER_S16_SAMPLE;

let modelId: string | null = null;

async function cleanup() {
  if (modelId) {
    await unloadModel({ modelId });
  }
}

function readS16leFromWav(wavPath: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const proc = spawn(
      "ffmpeg",
      [
        "-i",
        wavPath,
        "-ar",
        String(SAMPLE_RATE),
        "-ac",
        "1",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    proc.stdout.on("data", (buf: Buffer) => chunks.push(buf));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}`));
        return;
      }
      const merged = Buffer.concat(chunks);
      resolve(
        new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength),
      );
    });
  });
}

const loadOptions: LoadModelOptions = {
  modelType: "parakeet-transcription",
  modelConfig: { ...SORTFORMER_V21_AOSC_LOAD_CONFIG },
  onProgress: (p) => {
    const mb = (n: number) => (n / 1e6).toFixed(1);
    const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
    process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
    if (p.percentage >= 100) process.stderr.write("\n");
  },
  ...(sortformerOverride
    ? { modelSrc: sortformerOverride }
    : { modelSrc: PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0 }),
};

try {
  console.log(
    "▸ Loading Sortformer v2.1 with streaming + AOSC (load-time config)...",
  );
  modelId = await loadModel(loadOptions);
  console.log(`▸ Model loaded: ${modelId}`);

  const session = await transcribeStream({
    modelId,
    parakeetStreamingConfig: { chunkMs: STREAM_CHUNK_MS },
  });

  console.log(
    `▸ Streaming ${audioFilePath} in ${STREAM_CHUNK_MS}ms chunks (wall-clock paced)...`,
  );

  const pcm = await readS16leFromWav(audioFilePath);
  const trailingSilenceMs = 1500;
  const trailingBytes = new Uint8Array(
    Math.floor((trailingSilenceMs / 1000) * SAMPLE_RATE) * BYTES_PER_S16_SAMPLE,
  );

  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, pcm.length);
    session.write(pcm.subarray(offset, end));
    if (end < pcm.length) {
      await new Promise((resolve) => setTimeout(resolve, STREAM_CHUNK_MS));
    }
  }

  for (let offset = 0; offset < trailingBytes.length; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, trailingBytes.length);
    session.write(trailingBytes.subarray(offset, end));
    if (end < trailingBytes.length) {
      await new Promise((resolve) => setTimeout(resolve, STREAM_CHUNK_MS));
    }
  }

  session.end();

  const lines: string[] = [];
  for await (const event of session) {
    if (event.type === "text" && event.text.trim()) {
      lines.push(event.text.trim());
      console.log(event.text.trim());
    }
  }

  console.log("\n▸ Streaming diarization transcript");
  console.log(lines.join("\n") || "(no speaker lines emitted)");

  await cleanup();
  process.exit(0);
} catch (error) {
  console.error("✖", error);
  await cleanup();
  process.exit(1);
}
