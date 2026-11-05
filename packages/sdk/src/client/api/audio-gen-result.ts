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
  type AudioGenEncodedAudio,
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

/**
 * A queue one consumer drains as an async generator. It ends when the run
 * does, and throws the run's error once the queued items are delivered.
 */
function createFeed<T>() {
  const queue: T[] = []
  let closed = false
  let failure: Error | undefined
  let wake: (() => void) | undefined

  function notify() {
    wake?.()
    wake = undefined
  }

  async function* drain(): AsyncGenerator<T> {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift() as T
        continue
      }
      if (closed) {
        if (failure !== undefined) throw failure
        return
      }
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  }

  return {
    push(item: T) {
      queue.push(item)
      notify()
    },
    close(error?: Error) {
      closed = true
      failure = error
      notify()
    },
    stream: drain()
  }
}

/**
 * Copies one PCM frame into its own `Int16Array`. The copy keeps a caller
 * that edits a chunk in place from changing `audio`, and gives the samples
 * the alignment a view over the decoded bytes might lack.
 */
function toInt16Chunk(bytes: Uint8Array, wireType: string): Int16Array {
  if (bytes.byteLength % Int16Array.BYTES_PER_ELEMENT !== 0) {
    throw new InvalidResponseError(`${wireType} audio chunk`)
  }
  const samples = new Int16Array(bytes.byteLength / Int16Array.BYTES_PER_ELEMENT)
  new Uint8Array(samples.buffer).set(bytes)
  return samples
}

async function* int16Chunks(
  source: AsyncGenerator<Uint8Array>,
  wireType: string
): AsyncGenerator<Int16Array> {
  for await (const bytes of source) yield toInt16Chunk(bytes, wireType)
}

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
  return collectAudioRun(
    requestId,
    'audioGenStream',
    audioGenStreamResponseSchema,
    () => streamFactory(request),
    request.outputFormat !== undefined
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
  return collectAudioRun(
    requestId,
    'audioEditStream',
    audioEditStreamResponseSchema,
    () => streamFactory(request),
    request.outputFormat !== undefined
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
  /** The run is over: `error` is set when it failed, unset when it completed or was cancelled. */
  close?(error?: Error): void
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
  const progress = createFeed<AudioGenProgress>()

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

  function rejectAll(error: unknown) {
    rejectPayload(error)
    rejectStats(error)
    rejectDiagnostics(error)
  }

  async function processResponses() {
    let receivedDone = false
    let failure: Error | undefined
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

        if (frame.progress) progress.push(frame.progress)

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
      failure = error instanceof Error ? error : new InvalidResponseError(wireType, error)
      rejectAll(failure)
    } finally {
      progress.close(failure)
      sink.close?.(failure)
    }
  }

  void processResponses()

  return { requestId, progressStream: progress.stream, payload, stats, diagnostics }
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
 * `audio`, carrying the format reported alongside them, and are offered one
 * by one on `chunkStream`. The encoded file, when the request asked for one,
 * settles `encoded`.
 */
function collectAudioRun(
  requestId: string,
  wireType: AudioRunFrame['type'],
  responseSchema: z.ZodType<AudioRunFrame>,
  open: () => AsyncGenerator<unknown>,
  expectsEncoded: boolean
): AudioGenResult {
  const pcmChunks: Uint8Array[] = []
  let sampleRate: number | undefined
  let channels: number | undefined
  let bitsPerSample: number | undefined
  let encoded: AudioGenEncodedAudio | undefined
  // Holds the same arrays as `pcmChunks`; the Int16 copy is made as a chunk
  // is read, so a caller that never iterates `chunkStream` pays nothing.
  const chunks = createFeed<Uint8Array>()

  const { progressStream, payload, stats, diagnostics } = collectRun(
    requestId,
    wireType,
    responseSchema,
    open,
    {
      absorb(frame) {
        if (frame.encoded !== undefined) {
          encoded = { ...frame.encoded, data: decodeBase64(frame.encoded.data) }
        }
        if (frame.data === undefined) return
        const bytes = decodeBase64(frame.data)
        pcmChunks.push(bytes)
        chunks.push(bytes)
        sampleRate = frame.sampleRate
        channels = frame.channels
        bitsPerSample = frame.bitsPerSample
      },
      settle() {
        if (sampleRate === undefined || channels === undefined || bitsPerSample === undefined) {
          throw new InvalidResponseError(`${wireType} audio chunk`)
        }
        if (expectsEncoded && encoded === undefined) {
          throw new InvalidResponseError(`${wireType} encoded audio`)
        }
        return {
          audio: {
            pcm: concatenateChunks(pcmChunks),
            sampleRate,
            channels,
            bitsPerSample
          } satisfies AudioGenAudio,
          encoded
        }
      },
      close(error) {
        chunks.close(error)
      }
    }
  )

  const audio = payload.then((settled) => settled.audio)
  const encodedAudio = payload.then((settled) => settled.encoded)
  audio.catch(() => {})
  encodedAudio.catch(() => {})

  return {
    requestId,
    progressStream,
    chunkStream: int16Chunks(chunks.stream, wireType),
    audio,
    encoded: encodedAudio,
    stats,
    diagnostics
  }
}
