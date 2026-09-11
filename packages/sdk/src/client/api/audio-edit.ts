import type { AudioEditClientParams, AudioGenResult } from '@qvac/inference/surface'
import { stream as streamRpc } from '@/client/rpc/rpc-client'
import { createAudioEditResult } from '@/client/api/audio-gen-result'

/**
 * Edits a source recording with a loaded ACE-Step AudioGen model: an ordered
 * pipeline of `flow-edit` and `repaint` operations, executed in array order.
 *
 * @param params - Loaded model ID, the source audio, the ordered `operations`, and an optional `seed`.
 * @param params.sourceAudio - The recording to edit: a file path (decoded server-side) or raw
 *   interleaved stereo 48 kHz Float32 LE PCM bytes in `[-1, 1]`.
 * @param params.operations - `flow-edit` re-conditions the whole clip from a `from` prompt to a
 *   `to` prompt over an optional `nMin`/`nMax` diffusion window (turbo DiT variants only);
 *   `repaint` regenerates the `start`..`end` range (seconds) against a new `caption`, keeping the
 *   rest of the clip. Operations may repeat or mix.
 * @param params.seed - Seeds the first operation; each following operation uses `seed + index`.
 * @returns The same run shape as `audioGen()`: a synchronous request ID, generation progress stream, PCM audio promise, stats promise, and diagnostics promise.
 *
 * @example
 * ```typescript
 * const run = audioEdit({
 *   modelId,
 *   sourceAudio: "/path/to/song.wav",
 *   operations: [
 *     {
 *       type: "flow-edit",
 *       from: { caption: "original pop song", lyrics: originalLyrics },
 *       to: { caption: "guitar pop-rock", lyrics: newLyrics },
 *     },
 *     { type: "repaint", caption: "analog synth solo", start: 10, end: 20, mode: "balanced" },
 *   ],
 *   seed: 22883,
 * });
 * stopButton.onclick = () => cancel({ requestId: run.requestId });
 * const { pcm, sampleRate, channels, bitsPerSample } = await run.audio;
 * ```
 */
export function audioEdit(params: AudioEditClientParams): AudioGenResult {
  return createAudioEditResult(params, streamRpc)
}
