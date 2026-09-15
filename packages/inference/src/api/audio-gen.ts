import type { z } from 'zod'
import {
  audioEditClientParamsSchema,
  audioEditStreamResponseSchema,
  audioGenClientParamsSchema,
  audioGenStreamResponseSchema,
  audioUnderstandClientParamsSchema,
  audioUnderstandResponseSchema,
  type AudioEditClientParams,
  type AudioEditStreamRequest,
  type AudioEditStreamResponse,
  type AudioGenAudio,
  type AudioGenClientParams,
  type AudioGenProgress,
  type AudioGenResult,
  type AudioGenStats,
  type AudioGenStreamRequest,
  type AudioGenStreamResponse,
  type AudioGenUnderstandResult,
  type AudioUnderstandClientParams,
  type AudioUnderstandRequest,
  type AudioUnderstandResult,
  type InferenceBackendDiagnostics
} from '@/schemas/index'
import { stream } from '@/dispatch'
import { parseClientInput } from '@/api/parse-input'
import { generateRandomRequestId } from '@/runtime/request-id'
import { decodeBase64 } from '@/utils/encoding'
import { InvalidResponseError, InferenceCancelledError } from '@/errors/index'

function concatenateChunks(chunks: Uint8Array[]) {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const pcm = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    pcm.set(chunk, offset)
    offset += chunk.length
  }
  return pcm
}

/**
 * Generates audio (music / speech) from a caption using a loaded ACE-Step or
 * MiniMax-Music3 AudioGen model.
 *
 * @param params - AudioGen request parameters (model, caption, optional lyrics, seed, bpm, etc.).
 * @returns A result object exposing `requestId`, `progressStream` (async iterator of `{ stage, step, total }`), `audio` (promise of the generated PCM and its format), `stats` (promise of generation statistics), and `diagnostics` (promise of the backend selection detail for the run).
 *
 * @example
 * ```typescript
 * const { progressStream, audio } = audioGen({ modelId, caption: "lo-fi hip hop, mellow piano" });
 * for await (const { stage, step, total } of progressStream) {
 *   console.log(total > 0 ? `${stage} ${step}/${total}` : `${stage} ${step} (indeterminate)`);
 * }
 * const { pcm, sampleRate, channels, bitsPerSample } = await audio;
 * ```
 */
export function audioGen(params: AudioGenClientParams): AudioGenResult {
  const parsed = parseClientInput(audioGenClientParamsSchema, params)
  const requestId = generateRandomRequestId()
  const request: AudioGenStreamRequest = {
    ...parsed,
    type: 'audioGenStream',
    requestId
  }
  return collectAudioRun(request, requestId, audioGenStreamResponseSchema)
}

/**
 * Edits a source recording with a loaded ACE-Step AudioGen model: an ordered
 * pipeline of `flow-edit` (re-condition the whole clip from one prompt to
 * another) and `repaint` (regenerate a time range) operations, executed in
 * array order. The source is interleaved stereo 48 kHz PCM — a file path
 * decoded server-side, or raw Float32 LE bytes in `[-1, 1]`.
 *
 * @param params - Loaded model ID, the source audio, the ordered `operations`, and an optional `seed`.
 * @returns The same run shape as `audioGen()`: `requestId`, `progressStream`, `audio`, `stats`, and `diagnostics`.
 *
 * @example
 * ```typescript
 * const run = audioEdit({
 *   modelId,
 *   sourceAudio: "/path/to/song.wav",
 *   operations: [
 *     { type: "flow-edit", from: { caption: "acoustic folk" }, to: { caption: "synthwave" } },
 *     { type: "repaint", caption: "analog synth solo", start: 10, end: 20 },
 *   ],
 *   seed: 7,
 * });
 * const { pcm, sampleRate, channels, bitsPerSample } = await run.audio;
 * ```
 */
export function audioEdit(params: AudioEditClientParams): AudioGenResult {
  const parsed = parseClientInput(audioEditClientParamsSchema, params)
  const requestId = generateRandomRequestId()
  const request: AudioEditStreamRequest = {
    ...parsed,
    type: 'audioEditStream',
    requestId
  }
  return collectAudioRun(request, requestId, audioEditStreamResponseSchema)
}

/**
 * Describes a recording with a loaded ACE-Step AudioGen model, running the
 * engine's reverse pipeline: the PCM is encoded, its FSQ semantic codes are
 * recovered, and the LM reports the clip's caption and metadata. The recovered
 * `audioCodes` can be fed straight back into `audioGen()`.
 *
 * @param params - Loaded model ID, the source audio, and optional LM sampling controls.
 * @returns `requestId`, `progressStream`, the `description`, `stats`, and `diagnostics`.
 *
 * @example
 * ```typescript
 * const run = audioUnderstand({ modelId, sourceAudio: "/path/to/song.wav" });
 * const { caption, bpm, keyscale, audioCodes } = await run.description;
 * ```
 */
export function audioUnderstand(params: AudioUnderstandClientParams): AudioUnderstandResult {
  const parsed = parseClientInput(audioUnderstandClientParamsSchema, params)
  const requestId = generateRandomRequestId()
  const request: AudioUnderstandRequest = {
    ...parsed,
    type: 'audioUnderstand',
    requestId
  }

  const progressQueue: AudioGenProgress[] = []
  let progressDone = false
  let progressError: Error | undefined
  let progressResolve: (() => void) | undefined
  let seen: AudioGenUnderstandResult | undefined

  let resolveDescription: (result: AudioGenUnderstandResult) => void = () => {}
  let rejectDescription: (error: unknown) => void = () => {}
  const description = new Promise<AudioGenUnderstandResult>((resolve, reject) => {
    resolveDescription = resolve
    rejectDescription = reject
  })
  description.catch(() => {})

  let resolveStats: (stats: AudioGenStats | undefined) => void = () => {}
  let rejectStats: (error: unknown) => void = () => {}
  const stats = new Promise<AudioGenStats | undefined>((resolve, reject) => {
    resolveStats = resolve
    rejectStats = reject
  })
  stats.catch(() => {})

  let resolveDiagnostics: (diagnostics: InferenceBackendDiagnostics | undefined) => void = () => {}
  let rejectDiagnostics: (error: unknown) => void = () => {}
  const diagnostics = new Promise<InferenceBackendDiagnostics | undefined>((resolve, reject) => {
    resolveDiagnostics = resolve
    rejectDiagnostics = reject
  })
  diagnostics.catch(() => {})

  function notifyProgress() {
    progressResolve?.()
    progressResolve = undefined
  }

  async function processResponses() {
    let receivedDone = false
    try {
      for await (const response of stream(request)) {
        if (
          !response ||
          typeof response !== 'object' ||
          !('type' in response) ||
          response.type !== 'audioUnderstand'
        ) {
          continue
        }
        const chunk = audioUnderstandResponseSchema.parse(response)

        if (chunk.progress) {
          progressQueue.push(chunk.progress)
          notifyProgress()
        }

        if (chunk.understand !== undefined) {
          seen = chunk.understand
        }

        if (chunk.done) {
          receivedDone = true
          if (chunk.stopReason === 'cancelled') {
            const error = new InferenceCancelledError(requestId)
            rejectDescription(error)
            rejectStats(error)
            rejectDiagnostics(error)
            break
          }
          // The engine repeats the description on the terminal stats, so the
          // streamed item is only a fallback if that is ever absent.
          const result = chunk.stats?.understand ?? seen
          if (result === undefined) {
            throw new InvalidResponseError('audioUnderstand description')
          }
          resolveDescription(result)
          resolveStats(chunk.stats)
          resolveDiagnostics(chunk.diagnostics)
          break
        }
      }

      if (!receivedDone) {
        throw new InvalidResponseError('audioUnderstand terminal response')
      }
    } catch (error) {
      progressError =
        error instanceof Error ? error : new InvalidResponseError('audioUnderstand', error)
      rejectDescription(progressError)
      rejectStats(progressError)
      rejectDiagnostics(progressError)
    } finally {
      progressDone = true
      notifyProgress()
    }
  }

  async function* progressStream(): AsyncGenerator<AudioGenProgress> {
    while (true) {
      const tick = progressQueue.shift()
      if (tick) {
        yield tick
        continue
      }
      if (progressDone) {
        if (progressError !== undefined) throw progressError
        return
      }
      await new Promise<void>((resolve) => {
        progressResolve = resolve
      })
    }
  }

  void processResponses()

  return { requestId, progressStream: progressStream(), description, stats, diagnostics }
}

type AudioRunRequest = AudioGenStreamRequest | AudioEditStreamRequest
type AudioRunFrame = AudioGenStreamResponse | AudioEditStreamResponse

/**
 * Consumes one generation or editing stream into the shared run shape:
 * progress ticks are queued for `progressStream`, PCM chunks accumulate into
 * `audio`, and the terminal frame settles `stats` and `diagnostics`.
 */
function collectAudioRun(
  request: AudioRunRequest,
  requestId: string,
  responseSchema: z.ZodType<AudioRunFrame>
): AudioGenResult {
  const wireType = request.type

  const progressQueue: AudioGenProgress[] = []
  const pcmChunks: Uint8Array[] = []
  let sampleRate: number | undefined
  let channels: number | undefined
  let bitsPerSample: number | undefined
  let progressDone = false
  let progressError: Error | undefined
  let progressResolve: (() => void) | undefined

  let resolveAudio: (audio: AudioGenAudio) => void = () => {}
  let rejectAudio: (error: unknown) => void = () => {}
  const audio = new Promise<AudioGenAudio>((resolve, reject) => {
    resolveAudio = resolve
    rejectAudio = reject
  })
  audio.catch(() => {})

  let resolveStats: (stats: AudioGenStats | undefined) => void = () => {}
  let rejectStats: (error: unknown) => void = () => {}
  const stats = new Promise<AudioGenStats | undefined>((resolve, reject) => {
    resolveStats = resolve
    rejectStats = reject
  })
  stats.catch(() => {})

  let resolveDiagnostics: (diagnostics: InferenceBackendDiagnostics | undefined) => void = () => {}
  let rejectDiagnostics: (error: unknown) => void = () => {}
  const diagnostics = new Promise<InferenceBackendDiagnostics | undefined>((resolve, reject) => {
    resolveDiagnostics = resolve
    rejectDiagnostics = reject
  })
  diagnostics.catch(() => {})

  function notifyProgress() {
    progressResolve?.()
    progressResolve = undefined
  }

  async function processResponses() {
    let receivedDone = false
    try {
      for await (const response of stream(request)) {
        if (
          !response ||
          typeof response !== 'object' ||
          !('type' in response) ||
          response.type !== wireType
        ) {
          continue
        }
        const chunk = responseSchema.parse(response)

        if (chunk.progress) {
          progressQueue.push(chunk.progress)
          notifyProgress()
        }

        if (chunk.data !== undefined) {
          pcmChunks.push(decodeBase64(chunk.data))
          sampleRate = chunk.sampleRate
          channels = chunk.channels
          bitsPerSample = chunk.bitsPerSample
        }

        if (chunk.done) {
          receivedDone = true
          if (chunk.stopReason === 'cancelled') {
            const error = new InferenceCancelledError(requestId)
            rejectAudio(error)
            rejectStats(error)
            rejectDiagnostics(error)
            break
          }
          if (sampleRate === undefined || channels === undefined || bitsPerSample === undefined) {
            throw new InvalidResponseError(`${wireType} audio chunk`)
          }
          resolveAudio({
            pcm: concatenateChunks(pcmChunks),
            sampleRate,
            channels,
            bitsPerSample
          })
          resolveStats(chunk.stats)
          resolveDiagnostics(chunk.diagnostics)
          break
        }
      }

      if (!receivedDone) {
        throw new InvalidResponseError(`${wireType} terminal response`)
      }
    } catch (error) {
      progressError = error instanceof Error ? error : new InvalidResponseError(wireType, error)
      rejectAudio(progressError)
      rejectStats(progressError)
      rejectDiagnostics(progressError)
    } finally {
      progressDone = true
      notifyProgress()
    }
  }

  async function* progressStream(): AsyncGenerator<AudioGenProgress> {
    while (true) {
      const tick = progressQueue.shift()
      if (tick) {
        yield tick
        continue
      }
      if (progressDone) {
        if (progressError !== undefined) throw progressError
        return
      }
      await new Promise<void>((resolve) => {
        progressResolve = resolve
      })
    }
  }

  void processResponses()

  return {
    requestId,
    progressStream: progressStream(),
    audio,
    stats,
    diagnostics
  }
}
