import {
  loadModel,
  unloadModel,
  transcribe,
  PARAKEET_CTC_FP32,
  PARAKEET_CTC_TOKENIZER,
} from "@qvac/sdk";

const args = process.argv.slice(2);

if (!args[0]) {
  console.error(
    "Usage: bun run examples/transcription/parakeet-ctc-filesystem.ts <wav-file> " +
      "[model.onnx] [tokenizer.json]",
  );
  console.error("\nIf model paths are omitted, defaults to registry models.");
  process.exit(1);
}

const audioFilePath = args[0];
const parakeetCtcModelSrc = args[1] ?? PARAKEET_CTC_FP32;
const parakeetTokenizerSrc = args[2] ?? PARAKEET_CTC_TOKENIZER;

try {
  console.log("Loading Parakeet CTC model...");
  const modelId = await loadModel({
    modelSrc: parakeetCtcModelSrc,
    modelType: "parakeet",
    modelConfig: {
      modelType: "ctc",
      parakeetCtcModelSrc,
      parakeetTokenizerSrc,
    },
    onProgress: (progress) => {
      console.log(`Download progress: ${progress.percentage.toFixed(1)}%`);
    },
  });

  console.log(`Parakeet CTC model loaded with ID: ${modelId}`);

  console.log("Transcribing audio...");
  const text = await transcribe({ modelId, audioChunk: audioFilePath });

  console.log("Transcription result:");
  console.log(text);

  console.log("Unloading model...");
  await unloadModel({ modelId });
  console.log("Done");
} catch (error) {
  console.error("Error:", error);
  process.exit(1);
}
