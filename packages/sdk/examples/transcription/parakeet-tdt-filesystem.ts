import {
  loadModel,
  unloadModel,
  transcribe,
  PARAKEET_TDT_ENCODER_FP32,
  PARAKEET_TDT_DECODER_FP32,
  PARAKEET_TDT_VOCAB,
  PARAKEET_TDT_PREPROCESSOR_FP32,
} from "@qvac/sdk";

const args = process.argv.slice(2);

if (!args[0]) {
  console.error(
    "Usage: bun run examples/transcription/parakeet-tdt-filesystem.ts <wav-file-path> " +
      "[encoder-onnx] [decoder-onnx] [vocab-txt] [preprocessor-onnx]",
  );
  console.error("\nIf model paths are omitted, defaults to registry models.");
  process.exit(1);
}

const audioFilePath = args[0];

const parakeetEncoderSrc = args[1] ?? PARAKEET_TDT_ENCODER_FP32;
const parakeetDecoderSrc = args[2] ?? PARAKEET_TDT_DECODER_FP32;
const parakeetVocabSrc = args[3] ?? PARAKEET_TDT_VOCAB;
const parakeetPreprocessorSrc = args[4] ?? PARAKEET_TDT_PREPROCESSOR_FP32;

try {
  console.log("Starting Parakeet transcription example...");

  console.log("Loading Parakeet model...");
  const modelId = await loadModel({
    modelSrc: parakeetEncoderSrc,
    modelType: "parakeet",
    modelConfig: {
      parakeetEncoderSrc,
      parakeetDecoderSrc,
      parakeetVocabSrc,
      parakeetPreprocessorSrc,
    },
    onProgress: (progress) => {
      console.log(`Download progress: ${progress.percentage.toFixed(1)}%`);
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
