import {
  loadModel,
  unloadModel,
  transcribe,
  PARAKEET_TDT_0_6B_V3_Q8_0,
} from "@qvac/sdk";

const args = process.argv.slice(2);

if (!args[0]) {
  console.error(
    "Usage: bun run examples/transcription/parakeet-tdt-filesystem.ts <wav-file-path> " +
      "[parakeet-tdt-gguf]",
  );
  console.error("\nIf the model path is omitted, defaults to the registry model.");
  process.exit(1);
}

const audioFilePath = args[0];
const parakeetModelSrc = args[1] ?? PARAKEET_TDT_0_6B_V3_Q8_0;

try {
  console.log("Starting Parakeet transcription example...");

  console.log("Loading Parakeet model...");
  const modelId = await loadModel({
    modelSrc: parakeetModelSrc,
    modelType: "parakeet",
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
  console.error("❌ Error:", error);
  process.exit(1);
}
