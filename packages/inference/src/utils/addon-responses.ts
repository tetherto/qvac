import type ASRGgml from '@qvac/asr-ggml'

export interface LlmStats {
  TTFT?: number
  TPS?: number
  CacheTokens?: number
  promptTokens?: number
  generatedTokens?: number
  avgConcurrentSeq?: number
  backendDevice?: 'cpu' | 'gpu'
}

export interface LlmResponse {
  stats?: LlmStats
  iterate(): AsyncIterable<string>
}

export interface NmtStats {
  totalTime?: number
  totalTokens?: number
  decodeTime?: number
  encodeTime?: number
  TPS?: number
  TTFT?: number
}

export interface NmtResponse {
  stats?: NmtStats
  iterate(): AsyncIterable<string>
}

export interface TtsStats {
  audioDurationMs?: number
  totalSamples?: number
  enhancerBackendDevice?: number
  enhancerBackendId?: number
}

export interface TtsResponse {
  stats?: TtsStats
  iterate(): AsyncIterable<{ outputArray: ArrayLike<number> }>
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
