import { ModelType, type TranscribeSegment } from '@/schemas/index'
import { TranscriptionFailedError } from '@/errors/index'

/**
 * A native ASR segment, as emitted by either engine of `@qvac/asr-ggml`.
 * `text` plus the timing fields are shared; `isEndOfTurn` and `startsWord`
 * are parakeet-only and absent on whisper output.
 */
export interface AsrAddonSegment {
  text: string
  start?: number
  end?: number
  toAppend?: boolean
  id?: number
  /** Parakeet: the segment ends on a recognized end-of-utterance boundary. */
  isEndOfTurn?: boolean
  /** Parakeet: the segment begins a new SentencePiece word. */
  startsWord?: boolean
}

/**
 * Normalize a native ASR segment to the engine-level `TranscribeSegment`
 * shape exposed to callers: seconds → milliseconds, `toAppend` → `append`,
 * and defaults for optional fields. The two parakeet-only flags are carried
 * through only when the engine sent them, so whisper segments do not gain
 * fields whose value would be meaningless.
 */
export function toTranscribeSegment(chunk: AsrAddonSegment): TranscribeSegment {
  return {
    text: chunk.text,
    startMs: (chunk.start ?? 0) * 1000,
    endMs: (chunk.end ?? 0) * 1000,
    append: chunk.toAppend ?? false,
    id: chunk.id ?? 0,
    ...(chunk.isEndOfTurn !== undefined && { isEndOfTurn: chunk.isEndOfTurn }),
    ...(chunk.startsWord !== undefined && { startsWord: chunk.startsWord })
  }
}

/**
 * Engines whose native layer emits per-segment metadata. Both `@qvac/asr-ggml`
 * engines do: the parakeet output serializer sends `start`, `end`, `id`,
 * `toAppend`, `isEndOfTurn` and `startsWord` for every segment, and
 * `timestampsEnabled` defaults to true.
 */
const METADATA_CAPABLE_ENGINES: readonly string[] = [
  ModelType.whispercppTranscription,
  ModelType.parakeetTranscription
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
