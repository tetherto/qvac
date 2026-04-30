import { loadModel, unloadModel, transcribe, WHISPER_TINY } from "@qvac/sdk";

// Parse command line arguments
const args = process.argv.slice(2);

if (!args[0]) {
  console.error(
    "Usage: bun run examples/whispercpp-filesystem.ts <wav-file-path>",
  );
  process.exit(1);
}

const audioFilePath = args[0];

try {
  console.log("🎤 Starting Whisper transcription example...");

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

  // Perform transcription with per-segment metadata
  console.log("🎧 Transcribing audio...");
  const segments = await transcribe({
    modelId,
    audioChunk: audioFilePath,
    metadata: true,
  });

  console.log("📝 Transcription result:");
  for (const segment of segments) {
    const start = (segment.startMs / 1000).toFixed(2);
    const end = (segment.endMs / 1000).toFixed(2);
    console.log(
      `  [${start}s → ${end}s] (id=${segment.id}, append=${segment.append}) ${segment.text}`,
    );
  }
  console.log(
    `\nFull transcript: ${segments.map((s) => s.text).join("").trim()}`,
  );

  // Unload the model when done
  console.log("🧹 Unloading Whisper model...");
  await unloadModel({ modelId });
  console.log("✅ Whisper model unloaded successfully");
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
