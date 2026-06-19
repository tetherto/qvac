/**
 * Parakeet TDT transcription from a WAV file.
 *
 * Usage:
 *   bun run examples/transcription/parakeet-tdt-filesystem.ts <wav-file> [parakeet-tdt-gguf]
 *
 * Loads a single GGUF checkpoint (`PARAKEET_TDT_0_6B_V3_Q8_0` by default) and
 * transcribes the file with the batch `transcribe` API. Omit the model
 * argument to use the registry constant.
 *
 * Audio should be 16 kHz mono PCM in a WAV container.
 */
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
  console.error(
    "\nIf the model path is omitted, defaults to the registry model.",
  );
  process.exit(1);
}

const audioFilePath = args[0];
const parakeetModelSrc = args[1] ?? PARAKEET_TDT_0_6B_V3_Q8_0;

try {
  console.log("▸ Starting Parakeet transcription example...");

  console.log("▸ Loading Parakeet model...");
  const modelId = await loadModel({
    modelSrc: parakeetModelSrc,
    modelType: "parakeet-transcription",
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });

  console.log(`▸ Parakeet model loaded with ID: ${modelId}`);

  console.log("▸ Transcribing audio...");
  const text = await transcribe({ modelId, audioChunk: audioFilePath });

  console.log(text);

  console.log("▸ Unloading Parakeet model...");
  await unloadModel({ modelId });
  console.log("▸ Parakeet model unloaded successfully");
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
