import {
  audioGenClientParamsSchema,
  audioGenStreamResponseSchema,
  type AudioGenAudio,
  type AudioGenClientParams,
  type AudioGenProgress,
  type AudioGenResult,
  type AudioGenStats,
  type AudioGenStreamRequest,
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
          response.type !== 'audioGenStream'
        ) {
          continue
        }
        const chunk = audioGenStreamResponseSchema.parse(response)

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
            throw new InvalidResponseError('audioGenStream audio chunk')
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
        throw new InvalidResponseError('audioGenStream terminal response')
      }
    } catch (error) {
      progressError =
        error instanceof Error ? error : new InvalidResponseError('audioGenStream', error)
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
