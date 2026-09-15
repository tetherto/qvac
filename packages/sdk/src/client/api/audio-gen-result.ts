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
} from '@qvac/inference/surface'
import type { z } from 'zod'
import { parseClientInput } from '@/client/parse-input'
import { generateClientRequestId } from '@/client/api/client-request-id'
import { decodeBase64 } from '@/utils/encoding'
import { InvalidResponseError } from '@/utils/errors-client'
import { InferenceCancelledError } from '@/utils/errors-server'

export type AudioGenStreamFactory = (request: AudioGenStreamRequest) => AsyncGenerator<unknown>
export type AudioEditStreamFactory = (request: AudioEditStreamRequest) => AsyncGenerator<unknown>
export type AudioUnderstandStreamFactory = (
  request: AudioUnderstandRequest
) => AsyncGenerator<unknown>

type AudioRunFrame = AudioGenStreamResponse | AudioEditStreamResponse

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
  return collectAudioRun(requestId, 'audioGenStream', audioGenStreamResponseSchema, () =>
    streamFactory(request)
  )
}

export function createAudioEditResult(
  params: AudioEditClientParams,
  streamFactory: AudioEditStreamFactory
): AudioGenResult {
  const parsed = parseClientInput(audioEditClientParamsSchema, params)
  const requestId = generateClientRequestId()
  const request: AudioEditStreamRequest = {
    ...parsed,
    type: 'audioEditStream',
    requestId
  }
  return collectAudioRun(requestId, 'audioEditStream', audioEditStreamResponseSchema, () =>
    streamFactory(request)
  )
}

export function createAudioUnderstandResult(
  params: AudioUnderstandClientParams,
  streamFactory: AudioUnderstandStreamFactory
): AudioUnderstandResult {
  const parsed = parseClientInput(audioUnderstandClientParamsSchema, params)
  const requestId = generateClientRequestId()
  const request: AudioUnderstandRequest = {
    ...parsed,
    type: 'audioUnderstand',
    requestId
  }
  return collectUnderstandRun(requestId, () => streamFactory(request))
}

/**
 * Consumes an `audioUnderstand()` stream. Shaped like `collectAudioRun`, but
 * the run yields a description rather than PCM: the engine streams it as one
 * `understand` item and repeats it on the terminal stats.
 */
function collectUnderstandRun(
  requestId: string,
  openStream: () => AsyncGenerator<unknown>
): AudioUnderstandResult {
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
      for await (const response of openStream()) {
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

/**
 * Consumes one generation or editing stream into the shared run shape:
 * progress ticks are queued for `progressStream`, PCM chunks accumulate into
 * `audio`, and the terminal frame settles `stats` and `diagnostics`.
 */
function collectAudioRun(
  requestId: string,
  wireType: AudioRunFrame['type'],
  responseSchema: z.ZodType<AudioRunFrame>,
  open: () => AsyncGenerator<unknown>
): AudioGenResult {
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
      for await (const response of open()) {
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
