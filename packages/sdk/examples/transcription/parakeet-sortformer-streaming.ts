/**
 * Parakeet Sortformer streaming diarization from a WAV file.
 *
 * Usage:
 *   bun run examples/transcription/parakeet-sortformer-streaming.ts <wav-file> [sortformer-gguf]
 *
 * Loads the Sortformer GGUF with AOSC streaming options in `modelConfig` and
 * runs batch `transcribe` over the file. Omit the model argument to use
 * `PARAKEET_SORTFORMER_4SPK_V1_Q8_0`.
 *
 * Audio should be 16 kHz mono PCM in a WAV container.
 */
import {
  loadModel,
  unloadModel,
  transcribe,
  PARAKEET_SORTFORMER_4SPK_V1_Q8_0,
} from "@qvac/sdk";

const args = process.argv.slice(2);

if (!args[0]) {
  console.error(
    "Usage: bun run examples/transcription/parakeet-sortformer-streaming.ts <wav-file-path> [sortformer-gguf]",
  );
  console.error("\nIf the model path is omitted, defaults to the registry model.");
  process.exit(1);
}

const audioFilePath = args[0];
const sortformerSrc = args[1] ?? PARAKEET_SORTFORMER_4SPK_V1_Q8_0;

try {
  console.log("Loading Sortformer GGUF with streaming + AOSC defaults...");
  const modelId = await loadModel({
    modelSrc: sortformerSrc,
    modelType: "parakeet",
    modelConfig: {
      streaming: true,
      streamingChunkMs: 2000,
      streamingChunkRightContextMs: 560,
      streamingSpkCacheEnable: true,
      streamingSpkCacheLen: 188,
      streamingFifoLen: 188,
      streamingChunkLeftContextMs: 80,
      streamingSpkCacheUpdatePeriod: 144,
    },
  });

  console.log(`Model loaded: ${modelId}`);
  const text = await transcribe({ modelId, audioChunk: audioFilePath });
  console.log("Diarization transcript:");
  console.log(text);

  await unloadModel({ modelId });
  process.exit(0);
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
