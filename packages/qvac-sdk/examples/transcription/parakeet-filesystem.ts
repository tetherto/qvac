import {
  loadModel,
  unloadModel,
  transcribe,
  PARAKEET_ENCODER_FP32,
  PARAKEET_ENCODER_DATA_FP32,
  PARAKEET_DECODER_FP32,
  PARAKEET_VOCAB,
  PARAKEET_PREPROCESSOR_FP32,
} from "@qvac/sdk";

// Parse command line arguments
const args = process.argv.slice(2);

if (!args[0]) {
  console.error(
    "Usage: bun run examples/parakeet-filesystem.ts <wav-file-path> " +
      "[encoder-onnx] [encoder-data] [decoder-onnx] [vocab-txt] [preprocessor-onnx]",
  );
  console.error(
    "\nIf model paths are omitted, defaults to registry models.",
  );
  process.exit(1);
}

const audioFilePath = args[0];

const modelSrc = args[1] || PARAKEET_ENCODER_FP32;
const parakeetEncoderDataSrc = args[2] || PARAKEET_ENCODER_DATA_FP32;
const parakeetDecoderSrc = args[3] || PARAKEET_DECODER_FP32;
const parakeetVocabSrc = args[4] || PARAKEET_VOCAB;
const parakeetPreprocessorSrc = args[5] || PARAKEET_PREPROCESSOR_FP32;

try {
  console.log("Starting Parakeet transcription example...");

  console.log("Loading Parakeet model...");
  const modelId = await loadModel({
    modelSrc,
    modelType: "parakeet",
    modelConfig: {
      parakeetEncoderDataSrc,
      parakeetDecoderSrc,
      parakeetVocabSrc,
      parakeetPreprocessorSrc,
    },
    onProgress: (progress) => {
      console.log(
        `Download progress: ${progress.percentage.toFixed(1)}%`,
      );
    },
  });

  console.log(`Parakeet model loaded with ID: ${modelId}`);

  console.log("Transcribing audio...");
  const text = await transcribe({ modelId, audioChunk: audioFilePath });

  console.log("Transcription result:");
  console.log(text);

  console.log("Unloading Parakeet model...");
  await unloadModel({ modelId });
  console.log("Parakeet model unloaded successfully");
} catch (error) {
  console.error("Error:", error);
  process.exit(1);
}
