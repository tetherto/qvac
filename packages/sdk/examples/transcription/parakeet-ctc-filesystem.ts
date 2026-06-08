/**
 * Parakeet CTC transcription from a WAV file.
 *
 * Usage:
 *   bun run examples/transcription/parakeet-ctc-filesystem.ts <wav-file> [parakeet-ctc-gguf]
 *
 * Loads a single GGUF checkpoint (`PARAKEET_CTC_0_6B_Q8_0` by default) and
 * transcribes the file with the batch `transcribe` API. Omit the model
 * argument to use the registry constant.
 *
 * Audio should be 16 kHz mono PCM in a WAV container.
 */
import {
  loadModel,
  unloadModel,
  transcribe,
  PARAKEET_CTC_0_6B_Q8_0,
} from "@qvac/sdk";

const args = process.argv.slice(2);

if (!args[0]) {
  console.error(
    "Usage: bun run examples/transcription/parakeet-ctc-filesystem.ts <wav-file> " +
      "[parakeet-ctc-gguf]",
  );
  console.error(
    "\nIf the model path is omitted, defaults to the registry model.",
  );
  process.exit(1);
}

const audioFilePath = args[0];
const parakeetModelSrc = args[1] ?? PARAKEET_CTC_0_6B_Q8_0;

try {
  console.log("Loading Parakeet CTC model...");
  const modelId = await loadModel({
    modelSrc: parakeetModelSrc,
    modelType: "parakeet-transcription",
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
  console.error("❌ Error:", error);
  process.exit(1);
}
