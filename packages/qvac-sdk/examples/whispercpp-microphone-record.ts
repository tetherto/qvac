import {
  loadModel,
  unloadModel,
  transcribe,
  transcribeStream,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
} from "@qvac/sdk";
import { spawn, spawnSync } from "child_process";
import * as readline from "readline";
import { platform } from "os";

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

function getAudioDevice(platformName: string): string {
  switch (platformName) {
    case "darwin":
      return ":0";
    case "win32":
      // Change as per your system
      return "audio=@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{58C07110-A4FD-4FF8-BA10-5A3C14389F71}";
    case "linux":
      return "default";
    default:
      throw new Error(
        `Unsupported platform for audio recording: ${platformName}`,
      );
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const isStreamingMode = args.includes("--stream");

// Show help if needed
if (args.includes("--help") || args.includes("-h")) {
  console.log("🎤 Microphone Transcription Demo");
  console.log("");
  console.log("Usage:");
  console.log(
    "  bun run examples/microphone-record-transcription.ts [options]",
  );
  console.log("");
  console.log("Options:");
  console.log(
    "  --stream              Enable real-time streaming transcription",
  );
  console.log("  --help, -h            Show this help message");
  console.log("");
  console.log(
    "Default behavior: Record audio, then transcribe when you stop recording",
  );
  console.log("With --stream: Transcribe audio in real-time as you speak");
  process.exit(0);
}

// Clean readline-based transcription session
function startInteractiveSession(rl: readline.Interface, modelId: string) {
  let isRecording = false;
  let ffmpeg: ReturnType<typeof spawn> | null = null;
  let audioBuffer = Buffer.alloc(0);
  let audioChunkBuffer = Buffer.alloc(0);
  const chunkSizeBytes = 96000; // ~3 seconds of audio at 16kHz 16-bit mono
  let lastProcessTime = 0;

  const showInstructions = () => {
    if (isStreamingMode) {
      console.log("🎤 Real-Time Transcription Session");
      console.log("📊 Format: 16kHz, 32-bit float, mono, f32le");
      console.log(
        `🎙️  Using ${platform() === "darwin" ? "macOS" : platform() === "win32" ? "Windows" : "Linux"} microphone`,
      );
      console.log("⏯️  Press Enter to START/STOP real-time transcription");
      console.log("🛑 Type 'q' and press Enter to quit");
    } else {
      console.log("🎤 Record-and-Transcribe Session");
      console.log("📊 Format: 16kHz, 32-bit float, mono, f32le");
      console.log(
        `🎙️  Using ${platform() === "darwin" ? "macOS" : platform() === "win32" ? "Windows" : "Linux"} microphone`,
      );
      console.log("⏯️  Press Enter to START/STOP recording");
      console.log("🛑 Type 'q' and press Enter to quit");
    }
    console.log("");
  };

  const startRecording = () => {
    if (isStreamingMode) {
      console.log("🔴 Starting real-time transcription...");
      audioChunkBuffer = Buffer.alloc(0);
      console.log("\n" + "═".repeat(80));
      console.log("🗣️  REAL-TIME TRANSCRIPTION");
      console.log("═".repeat(80));
      console.log("📝 Speak now, transcription will appear as you talk...");
      console.log("");
    } else {
      console.log("🔴 Starting recording...");
      audioBuffer = Buffer.alloc(0);
    }

    const currentPlatform = platform();

    const audioInputArgs = (() => {
      switch (currentPlatform) {
        case "darwin":
          return ["-f", "avfoundation", "-i", getAudioDevice(currentPlatform)];
        case "win32":
          return ["-f", "dshow", "-i", getAudioDevice(currentPlatform)];
        case "linux":
          return ["-f", "pulse", "-i", getAudioDevice(currentPlatform)];
        default:
          throw new Error(
            `Unsupported platform for audio recording: ${currentPlatform}`,
          );
      }
    })();

    ffmpeg = spawn(
      "ffmpeg",
      [
        ...audioInputArgs,
        "-ar",
        "16000", // 16kHz
        "-ac",
        "1", // Mono
        "-sample_fmt",
        "flt", // 32-bit float
        "-f",
        "f32le", // f32le output format
        "pipe:1", // Output to stdout
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );

    if (!ffmpeg.stdout) {
      console.error("Failed to create microphone stream");
      return;
    }

    if (isStreamingMode) {
      // Process audio chunks in real-time
      ffmpeg.stdout.on("data", (chunk: Buffer) => {
        audioChunkBuffer = Buffer.concat([audioChunkBuffer, chunk]);

        const now = Date.now();
        if (
          audioChunkBuffer.length >= chunkSizeBytes &&
          now - lastProcessTime > 1000
        ) {
          const chunkToProcess = audioChunkBuffer.slice(0, chunkSizeBytes);
          audioChunkBuffer = audioChunkBuffer.slice(chunkSizeBytes);
          lastProcessTime = now;

          if (chunkToProcess.length < 32000) return;

          void (async () => {
            try {
              for await (const textChunk of transcribeStream({
                modelId,
                audioChunk: chunkToProcess,
              })) {
                if (textChunk.trim() && !textChunk.includes("[BLANK_AUDIO]")) {
                  process.stdout.write(textChunk);
                }
              }
            } catch (error) {
              console.error(
                "\n⚠️  Transcription error:",
                error instanceof Error ? error.message : String(error),
              );
            }
          })();
        }
      });
    } else {
      // Buffer all audio data for later transcription
      ffmpeg.stdout.on("data", (chunk: Buffer) => {
        audioBuffer = Buffer.concat([audioBuffer, chunk]);
      });
    }

    isRecording = true;
    if (isStreamingMode) {
      console.log("✅ Real-time transcription active!");
      console.log("⏹️  Press Enter to STOP");
    } else {
      console.log("✅ Recording... speak now!");
      console.log("⏹️  Press Enter to STOP and transcribe");
    }
  };

  const stopRecording = async () => {
    if (!isRecording) return;

    if (ffmpeg) {
      ffmpeg.kill();
    }
    isRecording = false;

    if (isStreamingMode) {
      console.log("\n🛑 Stopping real-time transcription...");

      if (audioChunkBuffer.length > 0) {
        try {
          for await (const textChunk of transcribeStream({
            modelId,
            audioChunk: audioChunkBuffer,
          })) {
            if (textChunk.trim() && !textChunk.includes("[BLANK_AUDIO]")) {
              process.stdout.write(textChunk);
            }
          }
        } catch (error) {
          console.error(
            "\n❌ Final transcription failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      console.log("\n═".repeat(80));
      console.log("✅ Real-time transcription stopped");
      console.log("⏯️  Press Enter to start again...");
    } else {
      console.log("🛑 Stopping recording...");
      console.log(`📦 Recorded ${audioBuffer.length} bytes of audio`);
      console.log("🔄 Transcribing...");

      const startTime = Date.now();
      console.log("\n" + "═".repeat(80));
      console.log("🗣️  TRANSCRIPTION RESULT");
      console.log("═".repeat(80));

      try {
        const text = await transcribe({ modelId, audioChunk: audioBuffer });
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        console.log(`📝 "${text}"`);
        console.log("═".repeat(80));
        console.log(`✅ Transcription completed in ${elapsed}s`);
        console.log("\n⏯️  Press Enter to record again...");
      } catch (error) {
        console.error(
          "\n❌ Transcription failed:",
          error instanceof Error ? error.message : String(error),
        );
        console.log("\n⏯️  Press Enter to record again...");
      }
    }
  };

  showInstructions();

  const handleInput = (input: string) => {
    const command = input.trim().toLowerCase();

    if (command === "") {
      // Just pressed Enter - toggle recording
      if (isRecording) {
        void stopRecording();
      } else {
        startRecording();
      }
    } else if (command === "q") {
      console.log("\n🛑 Exiting...");
      if (ffmpeg) {
        ffmpeg.kill();
      }
      rl.close();
      return;
    } else {
      console.log(`❓ Unknown command: ${command}`);
      console.log("💡 Press Enter to start/stop, 'q' to quit");
    }

    rl.prompt();
  };

  rl.on("line", handleInput);
  rl.on("close", () => {
    if (ffmpeg) {
      ffmpeg.kill();
    }
  });

  rl.prompt();
}

async function main() {
  let modelId: string | null = null;
  let rl: readline.Interface | null = null;

  // Set up readline interface FIRST to keep event loop alive during model loading
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    if (isStreamingMode) {
      console.log("🎤 Streaming Transcription Microphone Demo");
      console.log("✨ Mode: Real-time streaming transcription");
    } else {
      console.log("🎤 Record-and-Transcribe Microphone Demo");
      console.log("✨ Mode: Record first, then transcribe");
      console.log("💡 Tip: Use --stream flag for real-time transcription");
    }
    console.log("⚠️  Requirements:");
    console.log("   - Microphone connected and accessible");
    console.log("   - FFmpeg installed");

    // Check FFmpeg availability
    checkFFmpegAvailable();

    // Load the Whisper model with VAD
    console.log("\n📥 Loading Whisper model with VAD...");
    modelId = await loadModel({
      modelSrc: WHISPER_TINY,
      modelType: "whisper",
      vadModelSrc: VAD_SILERO_5_1_2,
      modelConfig: {
        audio_format: "f32le",
        vad_params: {
          threshold: 0.6,
          min_speech_duration_ms: 250,
          min_silence_duration_ms: 2000,
          max_speech_duration_s: 30.0,
        },
      },
      onProgress: (progress) => {
        console.log(progress);
      },
    });

    console.log(`✅ Whisper model loaded with ID: ${modelId}`);

    // Start interactive session using the existing readline interface
    console.log("\n🎧 Starting interactive session...");
    startInteractiveSession(rl, modelId);
  } catch (error) {
    console.error(
      "❌ Error during transcription setup:",
      error instanceof Error ? error.message : String(error),
    );

    // Clean up on error
    if (rl) {
      rl.close();
    }
    if (modelId) {
      console.log("\n🧹 Unloading Whisper model...");
      await unloadModel({ modelId });
      console.log("✅ Whisper model unloaded successfully");
    }
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Stopping microphone transcription...");
});

// Start the application
main().catch(console.error);
