import { loadModel, unloadModel, transcribe } from "@qvac/sdk";

// Get HTTP URL from command line or use default HuggingFace URL
const httpUrl =
  process.argv[3] ||
  "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2/resolve/main/";

// Parse command line arguments
const audioFilePath = process.argv[2];

if (!audioFilePath) {
  console.error(
    "Usage: bun run examples/parakeet-filesystem.ts <wav-file-path> [model-http-url]",
  );
  process.exit(1);
}

try {
  console.log("🎤 Starting Parakeet transcription example...");
  console.log(`📦 Model source: ${httpUrl}`);

  // Load the Parakeet model from HTTP
  console.log("📥 Loading Parakeet model...");
  const modelId = await loadModel({
    modelSrc: httpUrl,
    modelType: "parakeet",
    modelConfig: {
      // Model variant: "tdt" (multilingual), "ctc" (English), "eou" (streaming), "sortformer" (diarization)
      modelType: "tdt",
      // Inference options
      maxThreads: 4,
      useGPU: false,
      // Audio settings (16kHz mono expected)
      sampleRate: 16000,
      channels: 1,
      // Output options
      timestampsEnabled: true,
      captionEnabled: false,
    },
    onProgress: (progress) => {
      const downloadedMB = (progress.downloaded / 1024 / 1024).toFixed(2);
      const totalMB = (progress.total / 1024 / 1024).toFixed(2);
      console.log(
        `Loading: ${progress.percentage.toFixed(1)}% (${downloadedMB}MB / ${totalMB}MB)`,
      );
    },
  });

  console.log(`✅ Parakeet model loaded with ID: ${modelId}`);

  // Perform transcription
  console.log("🎧 Transcribing audio...");
  const text = await transcribe({ modelId, audioChunk: audioFilePath });

  console.log("📝 Transcription result:");
  console.log(text);

  // Unload the model when done
  console.log("🧹 Unloading Parakeet model...");
  await unloadModel({ modelId });
  console.log("✅ Parakeet model unloaded successfully");

  process.exit(0);
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
