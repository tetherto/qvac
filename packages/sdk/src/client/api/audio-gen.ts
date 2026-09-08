import type { AudioGenClientParams, AudioGenResult } from '@qvac/inference/surface'
import { stream as streamRpc } from '@/client/rpc/rpc-client'
import { createAudioGenResult } from '@/client/api/audio-gen-result'

/**
 * Generates PCM audio using a loaded AudioGen model.
 *
 * @param params - Loaded model ID, required caption, and optional lyrics, musical controls, duration, and seed.
 * @param params.maxFrames - MiniMax semantic-frame cap; mutually exclusive with `duration`.
 * @param params.inferenceSteps - MiniMax flow steps for this run.
 * @param params.cfgScale - MiniMax flow classifier-free guidance scale for this run.
 * @param params.referenceAudio - Optional timbre reference: a file path (decoded server-side)
 *   or raw interleaved stereo 48 kHz Float32 LE PCM bytes.
 * @param params.sourceAudio - Source audio to re-render (same forms as `referenceAudio`);
 *   required when `taskType` is `"cover-nofsq"`.
 * @param params.taskType - `"text2music"` (default) or `"cover-nofsq"`.
 * @param params.audioCoverStrength - Source-context strength for cover tasks (0..1).
 * @param params.coverNoiseStrength - Initial source/noise blend for cover tasks (0..1).
 * @returns A run with a synchronous request ID, generation progress stream, PCM audio promise, stats promise, and diagnostics promise describing the backend the run resolved to.
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
 * // MiniMax-Music3 uses a local LM and synthesis GGUF pair:
 * const minimaxId = await loadModel({
 *   modelType: "audiogen",
 *   modelConfig: {
 *     engine: "minimax",
 *     lmModelSrc: "/models/mm3-lm-q8.gguf",
 *     synthModelSrc: "/models/mm3-synth-q8.gguf",
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
 * ```
 */
export function audioGen(params: AudioGenClientParams): AudioGenResult {
  return createAudioGenResult(params, streamRpc)
}
