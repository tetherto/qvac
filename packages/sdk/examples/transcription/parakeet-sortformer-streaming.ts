/**
 * Parakeet Sortformer v2.1 + AOSC streaming-diarization example.
 *
 * Companion to `parakeet-sortformer.ts` (offline). Where the offline
 * example slices the clip after the diarization pass finishes, this
 * one exercises the streaming path: a long-lived
 * SortformerStreamSession is opened and PCM is fed in chunks,
 * producing per-chunk speaker segments as the audio arrives. The v2.1
 * GGUF auto-enables the Audio-Online Speaker Cache (AOSC), which
 * anchors speaker-slot identity across silence and re-entry; the
 * cache geometry is exposed through the `streamingSpkCache*` /
 * `streamingFifo*` / `streamingChunk{Left,Right}ContextMs` knobs
 * below. parakeet-cpp ignores them on v1/v2 GGUFs, so leaving them
 * unset on those models is a no-op.
 *
 * Usage:
 *   bun examples/transcription/parakeet-sortformer-streaming.ts \
 *       <v2.1-sortformer-src> [path-to-audio]
 *
 * `<v2.1-sortformer-src>` is the model source string for the v2.1
 * Sortformer GGUF (e.g. an s3:// URL or local filesystem path).
 * Once the v2.1 GGUF is registered in `@qvac/sdk`'s model catalog,
 * you can import the named constant
 * (`PARAKEET_SORTFORMER_STREAMING_V21_AOSC`) instead of passing the
 * path on the CLI -- the auto-generated models.ts entry lands when
 * the upload sync runs after the GGUF is added to
 * `packages/registry-server/data/models.prod.json`.
 *
 * The audio file defaults to `examples/audio/diarization-sample-16k.wav`
 * (16 kHz mono PCM WAV) -- the same fixture the offline example uses.
 * Pass a custom audio path as the second argument.
 */
import { loadModel, unloadModel, transcribe } from "@qvac/sdk";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const sortformerSrc = args[0];
if (!sortformerSrc) {
  console.error(
    "Usage: bun examples/transcription/parakeet-sortformer-streaming.ts " +
    "<v2.1-sortformer-src> [path-to-audio]",
  );
  console.error(
    "       The first argument is the model source string (s3:// URL " +
    "or local path) for the v2.1 Sortformer GGUF.",
  );
  process.exit(1);
}

const defaultAudioPath = join(
  __dirname,
  "..",
  "audio",
  "diarization-sample-16k.wav",
);
const audioFilePath = args[1] ?? defaultAudioPath;

try {
  // Open a long-lived SortformerStreamSession at load time. The v2.1
  // GGUF is auto-detected via its `parakeet.model_variant` metadata tag;
  // AOSC is then enabled by default. All `streamingSpkCache*` /
  // `streamingFifo*` / `streamingChunk{Left,Right}ContextMs` defaults
  // mirror parakeet-cpp's NeMo-port tuning -- we leave them unset here
  // to demonstrate the zero-config path, then override one knob below
  // to show the override surface works.
  const sfModelId = await loadModel({
    modelSrc: sortformerSrc,
    modelType: "parakeet",
    modelConfig: {
      modelType: "sortformer",
      parakeetSortformerSrc: sortformerSrc,

      // Open a streaming session at load time so cross-chunk state (the
      // AOSC speaker cache, in this case) is preserved within the run.
      streaming: true,
      streamingChunkMs: 2000,
      // Larger encoder right-context = lower per-chunk drop rate at the
      // cost of higher per-chunk latency. Tune for your transport.
      streamingChunkRightContextMs: 560,
      // streamingSpkCacheEnable defaults to true; set false here to A/B
      // against the v1 sliding-window path on the same GGUF.
      // streamingSpkCacheEnable: false,
    },
  });

  // Run the streaming transcription. The SDK transcribe handler is
  // already a streaming yield ('streaming: true' on the plugin handler);
  // the underlying TranscriptionParakeet wrapper feeds chunks into the
  // open SortformerStreamSession and surfaces per-chunk speaker segments
  // as they emit.
  const diarization = await transcribe({
    modelId: sfModelId,
    audioChunk: audioFilePath,
  });

  await unloadModel({ modelId: sfModelId });

  // `diarization` is the addon's familiar
  // "Speaker N: HH:MM:SS.fff - HH:MM:SS.fff" string per segment. The
  // AOSC guarantee from v2.1: when the same physical speaker re-enters
  // after silence, they get the same `Speaker N` tag as before. v1
  // could not promise this and would occasionally renumber slots once
  // two voices had been seen.
  console.log("\n=== STREAMING DIARIZATION (v2.1 + AOSC) ===");
  console.log("=".repeat(60));
  console.log(diarization);
  console.log("=".repeat(60));
  console.log("\nDone!");
  process.exit(0);
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
