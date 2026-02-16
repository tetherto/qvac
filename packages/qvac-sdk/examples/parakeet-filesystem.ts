import { loadModel, unloadModel, transcribe } from "@qvac/sdk";

// Parse command line arguments
const args = process.argv.slice(2);

if (!args[0]) {
  console.error(
    "Usage: bun run examples/parakeet-filesystem.ts <wav-file-path> [model-path-or-url]",
  );
  process.exit(1);
}

const audioFilePath = args[0];

// Default to a HuggingFace HTTP URL if no model path provided
const modelSrc =
  args[1] ||
  "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/encoder-model.onnx";

try {
  console.log("🦜 Starting Parakeet transcription example...");

  // Load the Parakeet model
  console.log("📥 Loading Parakeet model...");
  const modelId = await loadModel({
    modelSrc,
    modelType: "parakeet",
    onProgress: (progress) => {
      console.log(
        `📊 Download progress: ${progress.percentage.toFixed(1)}%`,
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
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
