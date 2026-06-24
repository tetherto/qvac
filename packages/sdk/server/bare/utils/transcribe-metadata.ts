import { ModelType, type TranscribeSegment } from "@/schemas";
import { TranscriptionFailedError } from "@/utils/errors-server";

export interface WhisperAddonSegment {
  text: string;
  start?: number;
  end?: number;
  toAppend?: boolean;
  id?: number;
}

/**
 * Normalize a native whisper-addon segment to the SDK-level `TranscribeSegment`
 * shape exposed to callers: seconds → milliseconds, `toAppend` → `append`,
 * and defaults for optional fields.
 */
export function toTranscribeSegment(chunk: WhisperAddonSegment): TranscribeSegment {
  return {
    text: chunk.text,
    startMs: (chunk.start ?? 0) * 1000,
    endMs: (chunk.end ?? 0) * 1000,
    append: chunk.toAppend ?? false,
    id: chunk.id ?? 0,
  };
}

/**
 * Guard used by transcription ops when the caller opts into `metadata: true`.
 * Only the whisper engine emits per-segment metadata; any other engine
 * requesting metadata is rejected with `TranscriptionFailedError`.
 */
export function assertMetadataSupported(
  modelId: string,
  engineType: string,
  metadata: boolean | undefined,
): void {
  if (!metadata) return;
  if (engineType !== ModelType.whispercppTranscription) {
    throw new TranscriptionFailedError(
      `metadata mode is not supported on model ${modelId} (engine: ${engineType || "unknown"}); only the whisper engine supports metadata`,
    );
  }
}
