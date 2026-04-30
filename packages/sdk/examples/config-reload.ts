import { WHISPER_TINY, loadModel, transcribe, unloadModel } from "../index";

// Parse command line arguments
const args = process.argv.slice(2);

if (!args[0]) {
  console.error("Usage: bun run examples/config-reload.ts <audio-file-path>");
  process.exit(1);
}

const audioFilePath = args[0];

try {
  // Initial load with English language
  console.log("Loading Whisper model with English config...");
  const modelId = await loadModel({
    modelSrc: WHISPER_TINY,
    modelType: "whisper",
    modelConfig: {
      language: "en",
    },
  });

  // Transcribe with English config
  console.log("Transcribing audio with English config...");
  const englishText = await transcribe({
    modelId,
    audioChunk: audioFilePath,
  });
  console.log(`Transcription (EN): ${englishText}`);
  console.log();

  // Hot reload config - change language and temperature
  console.log("Hot reloading config (changing language and temperature)...");
  const reloadedId = await loadModel({
    modelId,
    modelType: "whisper",
    modelConfig: {
      language: "es", // Change to Spanish
    },
  });
  console.log(`Config reloaded, same model ID: ${reloadedId === modelId}`);

  // Transcribe again with updated config
  console.log("Transcribing with updated config...");
  const spanishText = await transcribe({
    modelId,
    audioChunk: audioFilePath,
  });
  console.log(`Transcription (ES): ${spanishText}`);

  await unloadModel({ modelId });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
