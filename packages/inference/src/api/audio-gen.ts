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
} from '@/schemas/index'
import { stream } from '@/dispatch'
import { parseClientInput } from '@/api/parse-input'
import { generateRandomRequestId } from '@/runtime/request-id'
import { decodeBase64 } from '@/utils/encoding'
import {
  AudioEncodeFailedError,
  InvalidResponseError,
  InferenceCancelledError
} from '@/errors/index'

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
  indexes: AsyncGenerator<number>,
  read: (index: number) => Uint8Array,
  wireType: string
): AsyncGenerator<Int16Array> {
  for await (const index of indexes) yield toInt16Chunk(read(index), wireType)
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

/**
 * Generates audio (music / speech) from a caption using a loaded ACE-Step or
 * MiniMax-Music3 AudioGen model.
 *
 * @param params - AudioGen request parameters (model, caption, optional lyrics, seed, bpm, etc.).
 * @returns A result object exposing `requestId`, `progressStream` (async iterator of `{ stage, step, total }`), `audio` (promise of the generated PCM and its format), `chunkStream` (the same PCM as one `Int16Array` per engine chunk; the engines emit one chunk when generation finishes), `encoded` (promise of the file for `outputFormat`, or `undefined`), `stats` (promise of generation statistics), and `diagnostics` (promise of the backend selection detail for the run).
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
 * @param params - Loaded model ID, the source audio, the ordered `operations`, and optional run
 *   controls that apply to every operation: `seed`, a timbre `referenceAudio`, the prompt
 *   metadata (`vocalLanguage`, `bpm`, `keyscale`, `timesignature`, `augmentCaptionWithMetadata`),
 *   the Repaint DCW controls, and per-run `inferenceSteps` and `shift`.
 * @returns The same run shape as `audioGen()`: `requestId`, `progressStream`, `audio`, `chunkStream`, `encoded`, `stats`, and `diagnostics`.
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

  let seen: AudioGenUnderstandResult | undefined

  const { progressStream, payload, stats, diagnostics } = collectRun(
    request,
    requestId,
    audioUnderstandResponseSchema,
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

type AudioRunRequest = AudioGenStreamRequest | AudioEditStreamRequest
type AudioRunFrame = AudioGenStreamResponse | AudioEditStreamResponse

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
  request: AudioRunRequest | AudioUnderstandRequest,
  requestId: string,
  responseSchema: z.ZodType<TFrame>,
  sink: RunSink<TFrame, TPayload>
) {
  const wireType = request.type

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
      for await (const response of stream(request)) {
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
          resolvePayload(sink.settle(frame))
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
 * Consumes one generation or editing stream: PCM chunks accumulate into
 * `audio`, carrying the format reported alongside them, and are offered one
 * by one on `chunkStream`. The encoded file, when the request asked for one,
 * settles `encoded`; a failed encode rejects `encoded` and nothing else.
 */
function collectAudioRun(
  request: AudioRunRequest,
  requestId: string,
  responseSchema: z.ZodType<AudioRunFrame>
): AudioGenResult {
  const wireType = request.type
  const pcmChunks: Uint8Array[] = []
  let sampleRate: number | undefined
  let channels: number | undefined
  let bitsPerSample: number | undefined
  let encoded: AudioGenEncodedAudio | undefined
  let encodeFailure: AudioEncodeFailedError | undefined
  // The PCM is held once. Until the run settles it is the received chunks;
  // from then on it is `audio.pcm` alone, and the chunks are views into it.
  // `chunkStream` queues chunk indexes rather than bytes, so an unread
  // stream keeps no second copy of the audio alive.
  let settledPcm: Uint8Array | undefined
  const chunkEnds: number[] = []
  const chunks = createFeed<number>()

  function chunkBytes(index: number): Uint8Array {
    if (settledPcm === undefined) return pcmChunks[index] ?? new Uint8Array(0)
    const start = index > 0 ? (chunkEnds[index - 1] ?? 0) : 0
    return settledPcm.subarray(start, chunkEnds[index] ?? start)
  }

  const { progressStream, payload, stats, diagnostics } = collectRun(
    request,
    requestId,
    responseSchema,
    {
      absorb(frame) {
        if (frame.encoded !== undefined) {
          encoded = { ...frame.encoded, data: decodeBase64(frame.encoded.data) }
        }
        if (frame.encodeError !== undefined) {
          encodeFailure = new AudioEncodeFailedError(
            frame.encodeError.format,
            frame.encodeError.details
          )
        }
        if (frame.data === undefined) return
        const bytes = decodeBase64(frame.data)
        chunks.push(pcmChunks.length)
        pcmChunks.push(bytes)
        chunkEnds.push((chunkEnds.at(-1) ?? 0) + bytes.byteLength)
        sampleRate = frame.sampleRate
        channels = frame.channels
        bitsPerSample = frame.bitsPerSample
      },
      settle() {
        if (sampleRate === undefined || channels === undefined || bitsPerSample === undefined) {
          throw new InvalidResponseError(`${wireType} audio chunk`)
        }
        if (
          request.outputFormat !== undefined &&
          encoded === undefined &&
          encodeFailure === undefined
        ) {
          throw new InvalidResponseError(`${wireType} encoded audio`)
        }
        settledPcm = concatenateChunks(pcmChunks)
        pcmChunks.length = 0
        return {
          audio: {
            pcm: settledPcm,
            sampleRate,
            channels,
            bitsPerSample
          } satisfies AudioGenAudio,
          encoded,
          encodeFailure
        }
      },
      close(error) {
        chunks.close(error)
      }
    }
  )

  const audio = payload.then((settled) => settled.audio)
  // A failed encode rejects the file alone; the run itself completed.
  const encodedAudio = payload.then((settled) => {
    if (settled.encodeFailure !== undefined) throw settled.encodeFailure
    return settled.encoded
  })
  audio.catch(() => {})
  encodedAudio.catch(() => {})

  return {
    requestId,
    progressStream,
    chunkStream: int16Chunks(chunks.stream, chunkBytes, wireType),
    audio,
    encoded: encodedAudio,
    stats,
    diagnostics
  }
}
