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
 * One audiogen run, whatever it produces. Progress ticks queue for
 * `progressStream`, each frame is offered to the sink, and the terminal frame
 * settles the sink's payload alongside `stats` and `diagnostics`. Generation,
 * editing and understanding differ only in that payload, so they share this.
 */
interface RunSink<TFrame, TPayload> {
  /** Absorb a non-terminal frame. */
  absorb(frame: TFrame): void
  /** Build the payload from the terminal frame, or throw if it is incomplete. */
  settle(frame: TFrame): TPayload
}

interface RunFrame {
  progress?: AudioGenProgress | undefined
  done?: boolean | undefined
  stopReason?: string | undefined
  stats?: AudioGenStats | undefined
  diagnostics?: InferenceBackendDiagnostics | undefined
}

function collectRun<TFrame extends RunFrame, TPayload>(
  requestId: string,
  wireType: string,
  responseSchema: z.ZodType<TFrame>,
  open: () => AsyncGenerator<unknown>,
  sink: RunSink<TFrame, TPayload>
) {
  const progressQueue: AudioGenProgress[] = []
  let progressDone = false
  let progressError: Error | undefined
  let progressResolve: (() => void) | undefined

  let resolvePayload: (payload: TPayload) => void = () => {}
  let rejectPayload: (error: unknown) => void = () => {}
  const payload = new Promise<TPayload>((resolve, reject) => {
    resolvePayload = resolve
    rejectPayload = reject
  })
  payload.catch(() => {})

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

  function rejectAll(error: unknown) {
    rejectPayload(error)
    rejectStats(error)
    rejectDiagnostics(error)
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
        const frame = responseSchema.parse(response)

        if (frame.progress) {
          progressQueue.push(frame.progress)
          notifyProgress()
        }

        sink.absorb(frame)

        if (frame.done) {
          receivedDone = true
          if (frame.stopReason === 'cancelled') {
            rejectAll(new InferenceCancelledError(requestId))
            break
          }
          const settled = sink.settle(frame)
          resolvePayload(settled)
          resolveStats(frame.stats)
          resolveDiagnostics(frame.diagnostics)
          break
        }
      }

      if (!receivedDone) {
        throw new InvalidResponseError(`${wireType} terminal response`)
      }
    } catch (error) {
      progressError = error instanceof Error ? error : new InvalidResponseError(wireType, error)
      rejectAll(progressError)
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

  return { requestId, progressStream: progressStream(), payload, stats, diagnostics }
}

/**
 * Consumes an `audioUnderstand()` stream: the engine streams the description
 * as one `understand` item and repeats it on the terminal stats.
 */
function collectUnderstandRun(
  requestId: string,
  openStream: () => AsyncGenerator<unknown>
): AudioUnderstandResult {
  let seen: AudioGenUnderstandResult | undefined

  const { progressStream, payload, stats, diagnostics } = collectRun(
    requestId,
    'audioUnderstand',
    audioUnderstandResponseSchema,
    openStream,
    {
      absorb(frame) {
        if (frame.understand !== undefined) seen = frame.understand
      },
      settle(frame) {
        const result = frame.stats?.understand ?? seen
        if (result === undefined) {
          throw new InvalidResponseError('audioUnderstand description')
        }
        return result
      }
    }
  )

  return { requestId, progressStream, description: payload, stats, diagnostics }
}

/**
 * Consumes one generation or editing stream: PCM chunks accumulate into
 * `audio`, carrying the format reported alongside them.
 */
function collectAudioRun(
  requestId: string,
  wireType: AudioRunFrame['type'],
  responseSchema: z.ZodType<AudioRunFrame>,
  open: () => AsyncGenerator<unknown>
): AudioGenResult {
  const pcmChunks: Uint8Array[] = []
  let sampleRate: number | undefined
  let channels: number | undefined
  let bitsPerSample: number | undefined

  const { progressStream, payload, stats, diagnostics } = collectRun(
    requestId,
    wireType,
    responseSchema,
    open,
    {
      absorb(frame) {
        if (frame.data === undefined) return
        pcmChunks.push(decodeBase64(frame.data))
        sampleRate = frame.sampleRate
        channels = frame.channels
        bitsPerSample = frame.bitsPerSample
      },
      settle() {
        if (sampleRate === undefined || channels === undefined || bitsPerSample === undefined) {
          throw new InvalidResponseError(`${wireType} audio chunk`)
        }
        return {
          pcm: concatenateChunks(pcmChunks),
          sampleRate,
          channels,
          bitsPerSample
        } satisfies AudioGenAudio
      }
    }
  )

  return { requestId, progressStream, audio: payload, stats, diagnostics }
}
