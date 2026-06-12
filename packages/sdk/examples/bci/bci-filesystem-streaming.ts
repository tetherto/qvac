/**
 * Streaming BCI transcription from a neural-signal file.
 *
 * Reads a raw neural-signal `.bin` file and feeds it to the BCI
 * (whisper.cpp) addon chunk-by-chunk through a duplex `bciTranscribeStream`
 * session, printing transcript text as the sliding window decodes
 * successive windows.
 *
 * Usage: bun run examples/bci/bci-filesystem-streaming.ts <neural-bin-file-path>
 */
import {
  loadModel,
  unloadModel,
  bciTranscribeStream,
  BCI_WINDOWED,
} from "@qvac/sdk";
import { readFileSync } from "fs";

const args = process.argv.slice(2);

if (!args[0]) {
  console.error(
    "Usage: bun run examples/bci/bci-filesystem-streaming.ts <neural-bin-file-path>",
  );
  process.exit(1);
}

const neuralFilePath = args[0];

// Feed the neural buffer in fixed-size chunks to simulate a live stream.
const CHUNK_SIZE = 64 * 1024;

try {
  console.log("=== BCI transcribeStream file test ===");
  console.log(`File: ${neuralFilePath}`);
  console.log(`Chunk size: ${CHUNK_SIZE} bytes\n`);

  console.log("Loading model...");
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
  });
  console.log(`Model loaded: ${modelId}\n`);

  console.log("Opening live session...");
  const session = await bciTranscribeStream({ modelId, emit: "delta" });
  console.log("Session open. Streaming neural signal...\n");

  // Drain the session concurrently with writing so the sliding-window
  // decode can make progress as chunks arrive instead of stalling.
  const consume = (async () => {
    let transcript = "";
    for await (const text of session) {
      transcript += text;
      process.stdout.write(text);
    }
    return transcript;
  })();

  const data = readFileSync(neuralFilePath);

  let totalBytes = 0;
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const chunk = data.subarray(offset, offset + CHUNK_SIZE);
    session.write(chunk);
    totalBytes += chunk.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  console.log(`\n\nNeural signal streamed: ${totalBytes} bytes`);
  console.log("Waiting for transcription to finish...\n");
  session.end();

  const transcript = await consume;

  console.log("\n=== Results ===");
  console.log(`Transcript: ${transcript.trim() || "(no text received)"}`);

  console.log("\nUnloading model...");
  await unloadModel({ modelId });
  console.log("Done.");
  process.exit(0);
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
