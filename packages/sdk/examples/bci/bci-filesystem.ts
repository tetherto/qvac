/**
 * Batch BCI transcription from a neural-signal file.
 *
 * Reads a raw neural-signal `.bin` file, runs it through the BCI
 * (whisper.cpp) addon in one shot via `bciTranscribe`, and prints the
 * decoded transcript.
 *
 * Usage: bun run examples/bci/bci-filesystem.ts <neural-bin-file-path>
 */
import { loadModel, unloadModel, bciTranscribe, BCI_WINDOWED } from "@qvac/sdk";

const args = process.argv.slice(2);

if (!args[0]) {
  console.error("Usage: bun run examples/bci/bci-filesystem.ts <neural-bin-file-path>");
  process.exit(1);
}

const neuralFilePath = args[0];

try {
  console.log("🧠 Starting BCI transcription example...");

  console.log("📥 Loading BCI model...");
  const modelId = await loadModel({
    modelSrc: BCI_WINDOWED,
    modelConfig: {
      whisperConfig: {
        language: "en",
        n_threads: 4,
        temperature: 0.0,
      },
      // Session day index selects the day-specific projection matrices.
      // Set this to match the recording session your neural file came from.
      bciConfig: {
        day_idx: 1,
      },
    },
    onProgress: (progress) => {
      console.log(progress);
    },
  });

  console.log(`✅ BCI model loaded with ID: ${modelId}`);

  console.log("🧠 Transcribing neural signal...");
  const segments = await bciTranscribe({
    modelId,
    neuralData: neuralFilePath,
    metadata: true,
  });

  console.log("📝 Transcription result:");
  for (const segment of segments) {
    const start = (segment.startMs / 1000).toFixed(2);
    const end = (segment.endMs / 1000).toFixed(2);
    console.log(
      `  [${start}s → ${end}s] (id=${segment.id}, append=${segment.append}) ${segment.text}`,
    );
  }
  console.log(
    `\nFull transcript: ${segments
      .map((s) => s.text)
      .join("")
      .trim()}`,
  );

  console.log("🧹 Unloading BCI model...");
  await unloadModel({ modelId });
  console.log("✅ BCI model unloaded successfully");
  process.exit(0);
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
