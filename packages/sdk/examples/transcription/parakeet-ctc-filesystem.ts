import { loadModel, unloadModel, transcribe } from "@qvac/sdk";

const CTC_BASE =
  "https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX/resolve/main";

const args = process.argv.slice(2);

if (!args[0]) {
  console.error(
    "Usage: bun run examples/transcription/parakeet-ctc-filesystem.ts <wav-file> " +
      "[model.onnx] [model.onnx_data] [tokenizer.json]",
  );
  console.error(
    "\nIf model paths are omitted, defaults to onnx-community models.",
  );
  process.exit(1);
}

const audioFilePath = args[0];
const parakeetCtcModelSrc = args[1] ?? `${CTC_BASE}/onnx/model.onnx`;
const parakeetCtcModelDataSrc = args[2] ?? `${CTC_BASE}/onnx/model.onnx_data`;
const parakeetTokenizerSrc = args[3] ?? `${CTC_BASE}/tokenizer.json`;

try {
  console.log("Loading Parakeet CTC model...");
  const modelId = await loadModel({
    modelSrc: parakeetCtcModelSrc,
    modelType: "parakeet",
    modelConfig: {
      modelType: "ctc",
      parakeetCtcModelSrc,
      parakeetCtcModelDataSrc,
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
