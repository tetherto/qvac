import { loadModel, unloadModel, transcribe } from "@qvac/sdk";

const HF_BASE =
  "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main";

const DEFAULTS = {
  modelSrc: `${HF_BASE}/encoder-model.onnx`,
  parakeetEncoderDataSrc: `${HF_BASE}/encoder-model.onnx.data`,
  parakeetDecoderSrc: `${HF_BASE}/decoder_joint-model.onnx`,
  parakeetVocabSrc: `${HF_BASE}/vocab.txt`,
  parakeetPreprocessorSrc: `${HF_BASE}/nemo128.onnx`,
};

// Parse command line arguments
const args = process.argv.slice(2);

if (!args[0]) {
  console.error(
    "Usage: bun run examples/parakeet-filesystem.ts <wav-file-path> " +
      "[encoder-onnx] [encoder-data] [decoder-onnx] [vocab-txt] [preprocessor-onnx]",
  );
  console.error(
    "\nIf model paths are omitted, defaults to HuggingFace HTTP URLs.",
  );
  process.exit(1);
}

const audioFilePath = args[0];

const modelSrc = args[1] || DEFAULTS.modelSrc;
const parakeetEncoderDataSrc = args[2] || DEFAULTS.parakeetEncoderDataSrc;
const parakeetDecoderSrc = args[3] || DEFAULTS.parakeetDecoderSrc;
const parakeetVocabSrc = args[4] || DEFAULTS.parakeetVocabSrc;
const parakeetPreprocessorSrc = args[5] || DEFAULTS.parakeetPreprocessorSrc;

try {
  console.log("🦜 Starting Parakeet transcription example...");

  // Load the Parakeet model (all 5 files individually)
  console.log("📥 Loading Parakeet model...");
  const modelId = await loadModel({
    modelSrc,
    modelType: "parakeet",
    parakeetEncoderDataSrc,
    parakeetDecoderSrc,
    parakeetVocabSrc,
    parakeetPreprocessorSrc,
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
