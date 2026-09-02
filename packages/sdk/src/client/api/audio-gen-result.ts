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
} from '@qvac/inference/surface'
import { parseClientInput } from '@/client/parse-input'
import { generateClientRequestId } from '@/client/api/client-request-id'
import { decodeBase64 } from '@/utils/encoding'
import { InvalidResponseError } from '@/utils/errors-client'
import { InferenceCancelledError } from '@/utils/errors-server'

export type AudioGenStreamFactory = (request: AudioGenStreamRequest) => AsyncGenerator<unknown>

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

export function createAudioGenResult(
  params: AudioGenClientParams,
  streamFactory: AudioGenStreamFactory
): AudioGenResult {
  const parsed = parseClientInput(audioGenClientParamsSchema, params)
  const requestId = generateClientRequestId()
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
      for await (const response of streamFactory(request)) {
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
