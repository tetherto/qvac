import type { AudioGenClientParams, AudioGenResult } from '@/schemas/audio-gen'
import { stream as streamRpc } from '@/client/rpc/rpc-client'
import { createAudioGenResult } from '@/client/api/audio-gen-result'

/**
 * Generates PCM audio using a loaded AudioGen model.
 *
 * @param params - Loaded model ID, required caption, and optional lyrics, musical controls, duration, and seed.
 * @returns A run with a synchronous request ID, generation progress stream, PCM audio promise, and stats promise.
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
 * ```
 */
export function audioGen(params: AudioGenClientParams): AudioGenResult {
  return createAudioGenResult(params, streamRpc)
}
