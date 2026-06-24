/**
 * Microphone → Parakeet duplex streaming (`transcribeStream`).
 *
 * Usage:
 *   bun run examples/transcription/parakeet-microphone-stream.ts
 *
 * Streams microphone audio through `transcribeStream` with
 * `parakeetStreamingConfig`. Uses the EOU checkpoint so you may see
 * `{ type: "endOfTurn", source: "parakeet" }` events; CTC/TDT models
 * emit transcript text only. Parakeet does not yield standalone VAD events.
 *
 * Requirements: FFmpeg installed, microphone access.
 */
import {
  loadModel,
  unloadModel,
  transcribeStream,
  PARAKEET_EOU_120M_V1_Q8_0,
} from "@qvac/sdk";
import { spawnSync } from "child_process";
import { startMicrophone } from "../audio/mic-input";

const SAMPLE_RATE = 16000;

try {
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (r.error || r.status !== 0) throw new Error("FFmpeg not found");
} catch {
  console.error("✖ FFmpeg is required. Install it and try again.");
  process.exit(1);
}

let modelId: string | null = null;
let ffmpeg: ReturnType<typeof startMicrophone> | null = null;

async function cleanup() {
  console.log("\n▸ Stopping...");
  ffmpeg?.kill();
  if (modelId) await unloadModel({ modelId });
  console.log("▸ Done.");
}

process.on("SIGINT", () => {
  void cleanup().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void cleanup().finally(() => process.exit(0));
});

try {
  console.log("▸ Loading Parakeet (EOU) streaming model...");
  modelId = await loadModel({
    modelSrc: PARAKEET_EOU_120M_V1_Q8_0,
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });
  console.log("▸ Model loaded.");

  ffmpeg = startMicrophone({ sampleRate: SAMPLE_RATE, format: "s16le" });

  const session = await transcribeStream({
    modelId,
    parakeetStreamingConfig: {
      chunkMs: 1000,
      emitPartials: true,
    },
  });

  ffmpeg.stdout.on("data", (chunk: Buffer) => session.write(chunk));

  console.log(
    "▸ Listening... speak and pause to see transcripts. End-of-turn boundaries fire when the EOU model emits an <EOU> token.",
  );

  for await (const event of session) {
    switch (event.type) {
      case "text":
        if (event.text.trim()) {
          process.stdout.write(`${event.text}`);
        }
        break;
      case "endOfTurn":
        console.log("\n▸ [endOfTurn] turn boundary detected");
        break;
    }
  }
  await cleanup();
  process.exit(0);
} catch (error) {
  console.error("✖", error);
  await cleanup();
  process.exit(1);
}
