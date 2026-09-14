import type ASRGgml from '@qvac/asr-ggml'
import type TranslationNmtcpp from '@qvac/translation-nmtcpp'

export interface LlmStats {
  TTFT?: number
  TPS?: number
  ppTPS?: number
  CacheTokens?: number
  promptTokens?: number
  generatedTokens?: number
  avgConcurrentSeq?: number
  backendDevice?: 'cpu' | 'gpu'
  stopReason?:
    'none' | 'eos' | 'antiprompt' | 'predictionLimit' | 'sequenceLimit' | 'contextOverflow'
}

export interface LlmResponse {
  stats?: LlmStats
  iterate(): AsyncIterable<string>
}

export type NmtStats = TranslationNmtcpp.RuntimeStats
export type NmtResponse = TranslationNmtcpp.TranslationResponse

/**
 * @qvac/tts-ggml `RuntimeStats`. Restated here rather than imported from the
 * addon so a typecheck does not depend on which addon version happens to be
 * installed; keep it in step with the addon's `RuntimeStats`.
 */
export interface TtsStats {
  audioDurationMs?: number
  totalTime?: number
  realTimeFactor?: number
  tokensPerSecond?: number
  totalSamples?: number
  /** Audio8 only: codec frames generated, on a fixed 46 ms grid. */
  generatedFrames?: number
  backendDevice?: number
  backendId?: number
  gpuUnsupported?: number
  enhancerBackendDevice?: number
  enhancerBackendId?: number
}

/**
 * @qvac/tts-ggml `TTSOutputChunk & SentenceStreamChunkMeta`. The chunker runs
 * for `runStream()` and for `run({ streamOutput: true })` alike, so the meta
 * fields are populated on both paths.
 */
export interface TtsOutputChunk {
  outputArray: ArrayLike<number>
  /** Rate of `outputArray`; moves with `outputSampleRate` and the enhancer. */
  sampleRate?: number
  chunkIndex?: number
  sentenceChunk?: string
  /** True on the final pre-chunked output; undefined when it is not known up front. */
  isLast?: boolean
}

export interface TtsResponse {
  stats?: TtsStats
  iterate(): AsyncIterable<TtsOutputChunk>
}

export interface EmbedStats {
  total_time_ms?: number
  tokens_per_second?: number
  total_tokens?: number
  backendDevice?: 'cpu' | 'gpu'
  context_size?: number
}

export interface EmbedResponse {
  stats?: EmbedStats
  await(): Promise<Float32Array[][]>
}

export type TranscribeStats = Partial<ASRGgml.WhisperRuntimeStats & ASRGgml.ParakeetRuntimeStats>

export type TranscribeAddonSegment = ASRGgml.TranscriptionSegment
export type TranscribeAddonVadEvent = ASRGgml.VadEvent
export type TranscribeAddonEndOfTurnEvent = ASRGgml.EndOfTurnEvent
export type TranscribeAddonOutput = ASRGgml.ASRStreamOutput

export interface TranscribeResponse {
  stats?: TranscribeStats
  iterate(): AsyncIterable<TranscribeAddonOutput>
}
