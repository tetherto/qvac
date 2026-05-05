/**
 * Microphone → Whisper streaming transcription with conversation events
 * (VAD state updates + end-of-turn detection).
 *
 * Demonstrates the opt-in conversation API:
 *   transcribeStream({ modelId, emitVadEvents: true, endOfTurnSilenceMs: N })
 *
 * The session yields a discriminated union of events:
 *   - { type: "text", text }                      transcript chunks
 *   - { type: "vad", speaking, probability }      VAD state updates
 *   - { type: "endOfTurn", silenceDurationMs }    silence boundary
 *
 * Speak into your mic; transcripts appear as you pause, VAD ticks while
 * you speak, and an end-of-turn event fires after 800ms of silence.
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

try {
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (r.error || r.status !== 0) throw new Error("FFmpeg not found");
} catch {
  console.error("❌ Error: FFmpeg is required. Install it and try again.");
  process.exit(1);
}

let modelId: string | null = null;
let ffmpeg: ReturnType<typeof startMicrophone> | null = null;

async function cleanup() {
  console.log("\n\nStopping...");
  ffmpeg?.kill();
  if (modelId) await unloadModel({ modelId });
  console.log("Done.");
}

process.on("SIGINT", () => {
  void cleanup().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void cleanup().finally(() => process.exit(0));
});

try {
  console.log("Loading model (whisper-tiny + Silero VAD)...");
  modelId = await loadModel({
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

  ffmpeg = startMicrophone({ sampleRate: SAMPLE_RATE, format: "f32le" });

  const session = await transcribeStream({
    modelId,
    emitVadEvents: true,
    endOfTurnSilenceMs: 800,
  });

  ffmpeg.stdout.on("data", (chunk: Buffer) => session.write(chunk));

  console.log(
    "Listening... speak and pause to see transcripts, VAD events, and end-of-turn signals.\n",
  );

  let lastSpeaking = false;
  for await (const event of session) {
    switch (event.type) {
      case "text":
        console.log(`> ${event.text.trim()}`);
        break;
      case "vad":
        if (event.speaking !== lastSpeaking) {
          console.log(
            `[vad] speaking=${event.speaking} probability=${event.probability.toFixed(2)}`,
          );
          lastSpeaking = event.speaking;
        }
        break;
      case "endOfTurn":
        console.log(
          `[endOfTurn] silence ${event.silenceDurationMs}ms — turn complete\n`,
        );
        break;
    }
  }
} catch (error) {
  console.error("❌ Error:", error);
  await cleanup();
  process.exit(1);
}
