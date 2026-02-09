import { loadModel, unloadModel, transcribe } from "@qvac/sdk";

/**
 * Parakeet Transcription Example
 *
 * Downloads the TDT model from HuggingFace (community ONNX conversions):
 *   https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx
 *
 * Note: Only the TDT model variant is currently supported.
 *
 * Usage:
 *   bun run examples/parakeet-filesystem.ts <wav-file-path> [model-url]
 *
 * Example:
 *   bun run examples/parakeet-filesystem.ts ./audio.wav
 *   bun run examples/parakeet-filesystem.ts ./audio.wav https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx
 */

// Parse command line arguments
const args = process.argv.slice(2);

if (!args[0]) {
  console.error(
    "Usage: bun run examples/parakeet-filesystem.ts <wav-file-path> [model-url]",
  );
  process.exit(1);
}

const audioFilePath = args[0];
const modelUrl =
  args[1] || "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx";

try {
  console.log("Starting Parakeet transcription example...");
  console.log(`Model: ${modelUrl}`);
  console.log(`Audio: ${audioFilePath}`);

  // Load the Parakeet model - downloads all ONNX files from HuggingFace
  console.log("Loading Parakeet model (downloading if needed)...");
  const modelId = await loadModel({
    modelSrc: modelUrl,
    modelType: "parakeet",
    modelConfig: {
      // Only "tdt" is currently supported
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
        `Downloading: ${progress.percentage.toFixed(1)}% (${downloadedMB}MB / ${totalMB}MB)`,
      );
    },
  });

  console.log(`Parakeet model loaded with ID: ${modelId}`);

  // Perform transcription
  console.log("Transcribing audio...");
  const text = await transcribe({ modelId, audioChunk: audioFilePath });

  console.log("Transcription result:");
  console.log(text);

  // Unload the model when done
  console.log("Unloading Parakeet model...");
  try {
    await unloadModel({ modelId });
    console.log("Parakeet model unloaded successfully");
  } catch {
    // parakeet addon does not yet implement unload - process exit will clean up
    console.log("Parakeet model cleanup via process exit");
  }

  process.exit(0);
} catch (error) {
  console.error("Error:", error);
  process.exit(1);
}
