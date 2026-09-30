import type { AudioUnderstandClientParams, AudioUnderstandResult } from '@qvac/inference/surface'
import { stream as streamRpc } from '@/client/rpc/rpc-client'
import { createAudioUnderstandResult } from '@/client/api/audio-gen-result'

/**
 * Describes a recording with a loaded ACE-Step AudioGen model, running the
 * engine's reverse pipeline: the PCM is encoded, its FSQ semantic codes are
 * recovered, and the LM reports a caption and the clip's metadata.
 *
 * @param params - Loaded model ID, the source audio, and optional LM sampling controls.
 * @param params.sourceAudio - The recording to analyse: a file path (decoded server-side) or raw
 *   interleaved stereo 48 kHz Float32 LE PCM bytes in `[-1, 1]`.
 * @param params.vocalLanguage - Language hint forced into the result instead of the LM's guess.
 * @param params.seed - Seeds the LM decode; omit for a random seed.
 * @returns A synchronous request ID, a progress stream, the `description` promise, and the stats and diagnostics promises.
 *
 * @example
 * ```typescript
 * const run = audioUnderstand({ modelId, sourceAudio: "/path/to/song.wav" });
 * stopButton.onclick = () => cancel({ requestId: run.requestId });
 * const { caption, bpm, keyscale, timesignature, audioCodes } = await run.description;
 *
 * // The recovered codes re-synthesize the same piece without re-running the LM.
 * const remake = audioGen({ modelId, caption: "the same song, brighter mix", audioCodes });
 * ```
 */
export function audioUnderstand(params: AudioUnderstandClientParams): AudioUnderstandResult {
  return createAudioUnderstandResult(params, streamRpc)
}
