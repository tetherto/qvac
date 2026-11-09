import type { AudioGenClientParams, AudioGenResult } from '@qvac/inference/surface'
import { stream as streamRpc } from '@/client/rpc/rpc-client'
import { createAudioGenResult } from '@/client/api/audio-gen-result'

/**
 * Generates PCM audio using a loaded AudioGen model.
 *
 * @param params - Loaded model ID, required caption, and optional lyrics, musical controls, duration, and seed.
 * @param params.augmentCaptionWithMetadata - ACE-Step only: append BPM/tempo, time signature, and
 *   key guidance to the internal conditioning caption (default `false`).
 * @param params.audioCodes - ACE-Step only: frozen semantic codes (`Int32Array` or `number[]`)
 *   to synthesize instead of running the LM.
 * @param params.simpleMode - ACE-Step only: treat `caption` as a short query and let the LM compose
 *   the full request. Requires `taskType: "text2music"`; mutually exclusive with `rewriteQuery`.
 * @param params.rewriteQuery - ACE-Step only: the LM rewrites `caption` into a detailed description,
 *   keeping the lyrics. Needs real `lyrics`, and `taskType: "text2music"`.
 * @param params.generateLrc - ACE-Step only: return karaoke-style LRC in `stats.lrc` with an
 *   alignment confidence in `stats.lyricsScore`. Needs lyrics, and `taskType: "text2music"`.
 * @param params.computeQualityScore - ACE-Step only: report a weighted `[0, 1]` match of the codes
 *   against the request in `stats.qualityScore`. Requires `taskType: "text2music"`.
 * @param params.normalizeLoudness - ACE-Step only: percentile loudness normalization on the output
 *   (default `true`). Set `false` for the raw engine output.
 * @param params.guidanceScale - ACE-Step only: DiT classifier-free guidance scale; `0` (default)
 *   resolves per DiT variant.
 * @param params.track - ACE-Step only: the instrument layer the `"lego"` task regenerates.
 *   Required when `taskType` is `"lego"` and rejected otherwise.
 * @param params.maxFrames - MiniMax semantic-frame cap; mutually exclusive with `duration`.
 * @param params.inferenceSteps - Diffusion steps for this run (0..1000), on either engine; omit to
 *   keep the load-time value.
 * @param params.shift - ACE-Step only: DiT timestep shift for this run; omit to keep the load-time
 *   value.
 * @param params.cfgScale - MiniMax flow classifier-free guidance scale for this run.
 * @param params.referenceAudio - Optional timbre reference: a file path (decoded server-side)
 *   or raw interleaved stereo 48 kHz Float32 LE PCM bytes.
 * @param params.sourceAudio - Source audio to re-render (same forms as `referenceAudio`);
 *   required when `taskType` is `"cover-nofsq"`.
 * @param params.taskType - `"text2music"` (default), `"cover-nofsq"`, or `"lego"`.
 * @param params.audioCoverStrength - Source-context strength for cover tasks (0..1).
 * @param params.coverNoiseStrength - Initial source/noise blend for cover tasks (0..1).
 * @param params.outputFormat - Also deliver the finished audio as a file in this container
 *   (`AUDIOGEN_OUTPUT_FORMATS`), through `run.encoded`. `"wav"` is always available; the
 *   compressed formats need the matching FFmpeg encoder on the inference host, and the request
 *   fails with `AUDIO_ENCODE_FAILED` before generation starts when it is missing.
 * @returns A run with a synchronous request ID, generation progress stream, PCM audio promise, `chunkStream` (the same PCM as one `Int16Array` per engine chunk), `encoded` (the file for `outputFormat`, or `undefined`), stats promise, and diagnostics promise describing the backend the run resolved to. The engines emit the whole track as one chunk when generation finishes, so `chunkStream` is not incremental synthesis. The stats carry the backend the engine used (`backendDevice`, `backendId`) and `gpuFallbackReason`, the engine's code for a GPU request that landed on the CPU, which `diagnostics.fallback.reason` names. An ACE-Step run's stats carry `metadata`: the caption, lyrics and musical metadata it rendered and the seed it used. A MiniMax run's stats carry its stage timings and `emittedFrames`.
 *
 * @example
 * ```typescript
 * const modelId = await loadModel({
 *   modelType: "audiogen",
 *   modelConfig: {
 *     textEncModelSrc,
 *     lmModelSrc,
 *     ditModelSrc,
 *     vaeModelSrc,
 *   },
 * });
 * const run = audioGen({ modelId, caption: "ambient electronic music", duration: 10 });
 * stopButton.onclick = () => cancel({ requestId: run.requestId });
 * for await (const progress of run.progressStream) {
 *   console.log(progress.stage, progress.step, progress.total);
 * }
 * const { pcm, sampleRate, channels, bitsPerSample } = await run.audio;
 * const stats = await run.stats;
 *
 * // Ask for a file next to the PCM, and read the samples as Int16Array chunks:
 * const flacRun = audioGen({ modelId, caption: "ambient electronic music", outputFormat: "flac" });
 * for await (const samples of flacRun.chunkStream) {
 *   console.log(samples.length, "interleaved int16 samples");
 * }
 * const file = await flacRun.encoded;
 * if (file) await fs.writeFile(`track.${file.extension}`, file.data);
 *
 * // MiniMax-Music3 uses a local LM and synthesis GGUF pair:
 * const minimaxId = await loadModel({
 *   modelType: "audiogen",
 *   modelConfig: {
 *     engine: "minimax",
 *     lmModelSrc: "/models/mm3-lm-q8.gguf",
 *     synthModelSrc: "/models/mm3-synth-q8.gguf",
 *     device: "gpu", // fail the load instead of falling back to the CPU
 *   },
 * });
 *
 * // On macOS 15+, run MiniMax through a compiled full Core ML profile instead:
 * const coremlId = await loadModel({
 *   modelType: "audiogen",
 *   modelConfig: {
 *     engine: "minimax",
 *     lmModelSrc: "/models/mm3-lm-f16.gguf",
 *     synthModelSrc: "/models/mm3-synth-f16.gguf",
 *     coremlProfileDir: "/models/minimax-coreml",
 *     coremlComputeUnits: "CPU_AND_NE",
 *   },
 * });
 *
 * // ACE-Step can name the backend of its pipeline and of its LM independently:
 * const placedId = await loadModel({
 *   modelType: "audiogen",
 *   modelConfig: {
 *     textEncModelSrc,
 *     lmModelSrc,
 *     ditModelSrc,
 *     vaeModelSrc,
 *     backend: "CUDA0", // the load fails when the host cannot provide it
 *     lmBackend: "cpu",
 *   },
 * });
 * const minimaxRun = audioGen({
 *   modelId: minimaxId,
 *   caption: "warm cinematic piano",
 *   maxFrames: 250,
 *   inferenceSteps: 12,
 *   cfgScale: 1.8,
 * });
 *
 * // Re-render an existing song with a new caption (cover) and a timbre reference:
 * const cover = audioGen({
 *   modelId,
 *   caption: "orchestral arrangement with dramatic strings",
 *   taskType: "cover-nofsq",
 *   sourceAudio: "/path/to/source.wav",
 *   referenceAudio: "/path/to/reference.mp3",
 *   coverNoiseStrength: 0.75,
 * });
 *
 * // Let the LM expand a one-line query, and score and timestamp the take:
 * const assisted = audioGen({
 *   modelId,
 *   caption: "a hopeful indie track for a road-trip montage",
 *   simpleMode: true,
 *   generateLrc: true,
 *   computeQualityScore: true,
 * });
 * const { lrc, lyricsScore, qualityScore } = (await assisted.stats) ?? {};
 *
 * // What the LM composed, and the seed that replays the take:
 * const rendered = (await assisted.stats)?.metadata;
 * console.log(rendered?.caption, rendered?.lyrics, rendered?.bpm, rendered?.seed);
 *
 * // Rebuild one layer of an existing song:
 * const newDrums = audioGen({
 *   modelId,
 *   caption: "the same song with a busier, live-sounding kit",
 *   taskType: "lego",
 *   track: "drums",
 *   sourceAudio: "/path/to/song.wav",
 * });
 * ```
 */
export function audioGen(params: AudioGenClientParams): AudioGenResult {
  return createAudioGenResult(params, streamRpc)
}
