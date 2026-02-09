import { loadModel, unloadModel, transcribe } from "@qvac/sdk";

/**
 * Parakeet Transcription Example
 *
 * Downloads models from community HuggingFace repos (not NVIDIA):
 *   TDT (multilingual): https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx
 *   CTC (English-only): https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX
 *   EOU (streaming):    https://huggingface.co/altunene/parakeet-rs
 *
 * Preprocessor (required for TDT):
 *   https://huggingface.co/ysdede/parakeet-tdt-0.6b-v2-onnx/resolve/main/nemo128.onnx
 *
 * Usage:
 *   bun run examples/parakeet-filesystem.ts <model-dir> <wav-file-path>
 *
 * Example:
 *   bun run examples/parakeet-filesystem.ts ./models/parakeet-tdt-0.6b-v3-onnx ./audio.wav
 */

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length < 2) {
  console.error(
    "Usage: bun run examples/parakeet-filesystem.ts <model-dir> <wav-file-path>",
  );
  console.error(
    "Example: bun run examples/parakeet-filesystem.ts ./models/parakeet-tdt-0.6b-v3-onnx ./audio.wav",
  );
  process.exit(1);
}

const modelDir = args[0] as string;
const audioFilePath = args[1] as string;

// Point modelSrc to the encoder ONNX file; the addon loads all files from the same directory
const modelSrc = `${modelDir}/encoder-model.onnx`;

try {
  console.log("Starting Parakeet transcription example...");
  console.log(`Model directory: ${modelDir}`);
  console.log(`Audio file: ${audioFilePath}`);

  // Load the Parakeet model from local filesystem
  console.log("Loading Parakeet model...");
  const modelId = await loadModel({
    modelSrc,
    modelType: "parakeet",
    modelConfig: {
      // Model variant: "tdt" | "ctc" | "eou" | "sortformer"
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
      console.log(progress);
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
