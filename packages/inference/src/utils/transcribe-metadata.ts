import { ModelType, type TranscribeSegment, type TranscribeToken } from '@/schemas/index'
import { TranscriptionFailedError } from '@/errors/index'

/**
 * A native transcript segment, as emitted by the engines of
 * `@qvac/asr-ggml` and by `@qvac/bci-whispercpp`. `text` plus the timing
 * fields are shared; `isEndOfTurn` and `startsWord` are parakeet-only,
 * `language`, `noSpeechProb`, `speakerTurnNext` and `tokens` are whisper-only,
 * and `windowStartTimestep` is BCI delta-streaming-only.
 */
export interface AsrAddonToken {
  text: string
  /** Token start time in seconds. */
  start: number
  /** Token end time in seconds. */
  end: number
  probability: number
}

export interface AsrAddonSegment {
  text: string
  speakerId?: number
  speaker?: string
  speakerSegments?: { speakerId: number; start: number; end: number }[]
  start?: number
  end?: number
  toAppend?: boolean
  id?: number
  /** Parakeet: the segment ends on a recognized end-of-utterance boundary. */
  isEndOfTurn?: boolean
  /** Parakeet: the segment begins a new SentencePiece word. */
  startsWord?: boolean
  /** Whisper: language the window was decoded in (e.g. `"en"`). */
  language?: string
  /** Whisper: probability that the segment's window holds no speech. */
  noSpeechProb?: number
  /** Whisper with `tdrz_enable`: a speaker turn follows this segment. */
  speakerTurnNext?: boolean
  /** Whisper with `token_timestamps`: per-token text, timing and probability. */
  tokens?: AsrAddonToken[]
  /** BCI delta streaming: absolute timestep at which the owning window began. */
  windowStartTimestep?: number
}

function toTranscribeToken(token: AsrAddonToken): TranscribeToken {
  return {
    text: token.text,
    startMs: token.start * 1000,
    endMs: token.end * 1000,
    probability: token.probability
  }
}

/**
 * Normalize a native transcript segment to the engine-level
 * `TranscribeSegment` shape exposed to callers: seconds → milliseconds,
 * `toAppend` → `append`, and defaults for optional fields. The
 * engine-specific fields are carried through only when the engine sent them,
 * so a segment does not gain fields whose value would be meaningless.
 */
export function toTranscribeSegment(
  chunk: AsrAddonSegment
): TranscribeSegment & { windowStartTimestep?: number } {
  return {
    text: chunk.text,
    ...(chunk.speakerId !== undefined && { speakerId: chunk.speakerId }),
    ...(chunk.speaker !== undefined && { speaker: chunk.speaker }),
    ...(chunk.speakerSegments !== undefined && {
      speakerSegments: chunk.speakerSegments.map((turn) => ({
        speakerId: turn.speakerId,
        startMs: turn.start * 1000,
        endMs: turn.end * 1000
      }))
    }),
    startMs: (chunk.start ?? 0) * 1000,
    endMs: (chunk.end ?? 0) * 1000,
    append: chunk.toAppend ?? false,
    id: chunk.id ?? 0,
    ...(chunk.isEndOfTurn !== undefined && { isEndOfTurn: chunk.isEndOfTurn }),
    ...(chunk.startsWord !== undefined && { startsWord: chunk.startsWord }),
    ...(chunk.language !== undefined && { language: chunk.language }),
    ...(chunk.noSpeechProb !== undefined && { noSpeechProb: chunk.noSpeechProb }),
    ...(chunk.speakerTurnNext !== undefined && { speakerTurnNext: chunk.speakerTurnNext }),
    ...(chunk.tokens !== undefined && { tokens: chunk.tokens.map(toTranscribeToken) }),
    ...(chunk.windowStartTimestep !== undefined && {
      windowStartTimestep: chunk.windowStartTimestep
    })
  }
}

/**
 * Engines whose native layer emits per-segment metadata. MOSS supplies speaker
 * labels alongside timestamps; the parakeet output serializer sends `start`, `end`, `id`,
 * `toAppend`, `isEndOfTurn` and `startsWord` for every segment, and
 * `timestampsEnabled` defaults to true.
 */
const METADATA_CAPABLE_ENGINES: readonly string[] = [
  ModelType.whispercppTranscription,
  ModelType.parakeetTranscription,
  ModelType.mossTranscribe
]

/**
 * Guard used by transcription ops when the caller opts into `metadata: true`.
 */
export function assertMetadataSupported(
  modelId: string,
  engineType: string,
  metadata: boolean | undefined
): void {
  if (!metadata) return
  if (!METADATA_CAPABLE_ENGINES.includes(engineType)) {
    throw new TranscriptionFailedError(
      `metadata mode is not supported on model ${modelId} (engine: ${engineType || 'unknown'}); ` +
        `supported engines: ${METADATA_CAPABLE_ENGINES.join(', ')}`
    )
  }
}
