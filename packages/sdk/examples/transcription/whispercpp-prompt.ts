/**
 * Whisper transcription with prompt example.
 *
 * Usage:
 *   bun examples/transcription/whispercpp-prompt.ts
 *
 * This example requires a test audio file (default: examples/audio/sample-16khz.wav).
 * Sample audio files are available in the QVAC source repository, but not included in the published npm package.
 * Set audioChunk to a custom WAV, or download the default audio into examples/audio/:
 *   https://github.com/tetherto/qvac/blob/main/packages/sdk/examples/audio/sample-16khz.wav
 */
import { loadModel, unloadModel, transcribe, WHISPER_TINY } from "@qvac/sdk";

try {
  console.log("🎤 Starting Whisper transcription with prompt example...");

  // Load the Whisper model
  console.log("📥 Loading Whisper model...");
  const modelId = await loadModel({
    modelSrc: WHISPER_TINY,
    modelType: "whisper",
    modelConfig: {
      audio_format: "f32le",
      // Sampling strategy
      strategy: "greedy",
      n_threads: 4,
      // Transcription options
      language: "en",
      translate: false,
      no_timestamps: false,
      single_segment: false,
      print_timestamps: true,
      token_timestamps: true,
      // Quality settings
      temperature: 0.0,
      suppress_blank: true,
      suppress_nst: true,
      // Advanced tuning
      entropy_thold: 2.4,
      logprob_thold: -1.0,
      // VAD configuration
      vad_params: {
        threshold: 0.35,
        min_speech_duration_ms: 200,
        min_silence_duration_ms: 150,
        max_speech_duration_s: 30.0,
        speech_pad_ms: 600,
        samples_overlap: 0.3,
      },
      // Context parameters for GPU
      contextParams: {
        use_gpu: true,
        flash_attn: true,
        gpu_device: 0,
      },
    },
    onProgress: (progress) => {
      console.log(progress);
    },
  });

  console.log(`✅ Whisper model loaded with ID: ${modelId}`);

  // Perform transcription
  console.log("🎧 Transcribing audio...");
  const text = await transcribe({
    modelId,
    audioChunk: "examples/audio/sample-16khz.wav",
    prompt:
      "This is a test recording with clear speech and proper punctuation.",
  });

  console.log("📝 Transcription result:");
  console.log(text);

  // Unload the model when done
  console.log("🧹 Unloading Whisper model...");
  await unloadModel({ modelId });
  console.log("✅ Whisper model unloaded successfully");
  process.exit(0);
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
