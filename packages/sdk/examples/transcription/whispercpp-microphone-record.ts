import {
  loadModel,
  unloadModel,
  transcribe,
  transcribeLive,
  WHISPER_TINY,
} from "@qvac/sdk";
import { spawn, spawnSync } from "child_process";
import * as readline from "readline";
import { platform } from "os";

// ── Audio constants ──

const SAMPLE_RATE = 16000;

// ── Helpers ──

function checkFFmpegAvailable() {
  try {
    const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    if (result.error || result.status !== 0) {
      throw new Error("FFmpeg not available");
    }
  } catch {
    throw new Error(
      "FFmpeg is not installed or not available in PATH. Please install FFmpeg to use microphone recording.",
    );
  }
}

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
      throw new Error(`Unsupported platform for audio recording: ${platform()}`);
  }
}

function spawnMicrophone(): ReturnType<typeof spawn> {
  return spawn(
    "ffmpeg",
    [
      ...getAudioInputArgs(),
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      "1",
      "-sample_fmt",
      "flt",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
}

// ── Stream mode: true bidirectional streaming with addon VAD ──

async function runStreamMode(modelId: string, rl: readline.Interface) {
  const ffmpeg = spawnMicrophone();
  if (!ffmpeg.stdout) throw new Error("Failed to open microphone stream");

  console.log("\n" + "═".repeat(60));
  console.log("  TRUE STREAMING VAD TRANSCRIPTION");
  console.log("═".repeat(60));
  console.log("Audio streams directly to the Whisper addon.");
  console.log("The addon's native VAD detects speech and emits transcriptions.");
  console.log("Press Enter or Ctrl+C to quit.\n");

  const session = await transcribeLive({ modelId });

  // Pipe microphone audio into the live session
  ffmpeg.stdout.on("data", (chunk: Buffer) => {
    session.write(chunk);
  });

  ffmpeg.on("close", () => {
    session.end();
  });

  // Read transcription results as they arrive from the addon's VAD
  const transcriptionDone = (async () => {
    for await (const text of session) {
      process.stdout.write("\r" + " ".repeat(60) + "\r");
      console.log(`  ${text.trim()}`);
    }
  })();

  // Wait for user to press Enter to stop
  await new Promise<void>((resolve) => {
    rl.once("line", resolve);
  });

  ffmpeg.kill();
  session.end();
  await transcriptionDone;
}

// ── Batch mode: record then transcribe ──

async function runBatchMode(modelId: string, rl: readline.Interface) {
  let ffmpeg: ReturnType<typeof spawn> | null = null;
  let isRecording = false;
  let audioBuffer = Buffer.alloc(0);

  console.log("\n🎤 Record-and-Transcribe Session");
  console.log("📊 Format: 16kHz, 32-bit float, mono, f32le");
  console.log("⏯️  Press Enter to START/STOP recording");
  console.log("🛑 Type 'q' and press Enter to quit\n");

  function startRecording() {
    audioBuffer = Buffer.alloc(0);
    ffmpeg = spawnMicrophone();
    if (!ffmpeg.stdout) {
      console.error("Failed to create microphone stream");
      return;
    }
    ffmpeg.stdout.on("data", (chunk: Buffer) => {
      audioBuffer = Buffer.concat([audioBuffer, chunk]);
    });
    isRecording = true;
    console.log("🔴 Recording... speak now!");
    console.log("⏹️  Press Enter to STOP and transcribe");
  }

  async function stopRecordingAndTranscribe() {
    if (!isRecording) return;
    if (ffmpeg) ffmpeg.kill();
    isRecording = false;

    console.log("🛑 Stopping recording...");
    console.log(`📦 Recorded ${audioBuffer.length} bytes of audio`);
    console.log("🔄 Transcribing...");

    const startTime = Date.now();
    console.log("\n" + "═".repeat(60));
    console.log("🗣️  TRANSCRIPTION RESULT");
    console.log("═".repeat(60));

    try {
      const text = await transcribe({ modelId, audioChunk: audioBuffer });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`📝 "${text}"`);
      console.log("═".repeat(60));
      console.log(`✅ Transcription completed in ${elapsed}s`);
    } catch (error) {
      console.error(
        "\n❌ Transcription failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    console.log("\n⏯️  Press Enter to record again...");
  }

  await new Promise<void>((resolve) => {
    rl.on("line", (input: string) => {
      const cmd = input.trim().toLowerCase();
      if (cmd === "q") {
        if (ffmpeg) ffmpeg.kill();
        resolve();
        return;
      }
      if (cmd === "") {
        if (isRecording) {
          void stopRecordingAndTranscribe();
        } else {
          startRecording();
        }
      }
    });
  });
}

// ── Main ──

const args = process.argv.slice(2);
const isStreamMode = args.includes("--stream");

if (args.includes("--help") || args.includes("-h")) {
  console.log("🎤 Microphone Transcription Demo\n");
  console.log("Usage:");
  console.log(
    "  bun run examples/transcription/whispercpp-microphone-record.ts [options]\n",
  );
  console.log("Options:");
  console.log(
    "  --stream    True bidirectional streaming — audio streams to the addon,",
  );
  console.log(
    "              addon VAD detects speech and emits transcriptions (recommended)",
  );
  console.log("  --help, -h  Show this help message\n");
  console.log(
    "Default: Record first (press Enter to toggle), then transcribe the whole recording",
  );
  process.exit(0);
}

let modelId: string | null = null;
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

try {
  if (isStreamMode) {
    console.log("🎤 True Streaming VAD Transcription Demo");
    console.log("✨ Mode: Bidirectional stream — addon VAD drives transcription");
  } else {
    console.log("🎤 Record-and-Transcribe Microphone Demo");
    console.log("✨ Mode: Record first, then transcribe");
    console.log("💡 Tip: Use --stream for real-time VAD transcription");
  }
  console.log("⚠️  Requirements: Microphone + FFmpeg installed");

  checkFFmpegAvailable();

  console.log("\n📥 Loading Whisper model...");
  modelId = await loadModel({
    modelSrc: WHISPER_TINY,
    modelType: "whisper",
    modelConfig: {
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
        min_silence_duration_ms: 100,
        max_speech_duration_s: 30.0,
        speech_pad_ms: 200,
      },
    },
    onProgress: (progress) => {
      console.log(progress);
    },
  });

  console.log(`✅ Whisper model loaded with ID: ${modelId}`);

  if (isStreamMode) {
    await runStreamMode(modelId, rl);
  } else {
    await runBatchMode(modelId, rl);
  }

  console.log("\n🧹 Unloading Whisper model...");
  await unloadModel({ modelId });
  console.log("✅ Whisper model unloaded successfully");
  rl.close();
  process.exit(0);
} catch (error) {
  console.error(
    "❌ Error:",
    error instanceof Error ? error.message : String(error),
  );
  rl.close();
  if (modelId) {
    await unloadModel({ modelId });
  }
  process.exit(1);
}
