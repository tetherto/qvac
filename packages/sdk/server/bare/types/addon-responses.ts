export interface LlmStats {
  TTFT?: number;
  TPS?: number;
  CacheTokens?: number;
  generatedTokens?: number;
  backendDevice?: "cpu" | "gpu";
}

export interface LlmResponse {
  stats?: LlmStats;
  iterate(): AsyncIterable<string>;
}

export interface NmtStats {
  totalTime?: number;
  totalTokens?: number;
  decodeTime?: number;
  encodeTime?: number;
  TPS?: number;
  TTFT?: number;
}

export interface NmtResponse {
  stats?: NmtStats;
  iterate(): AsyncIterable<string>;
}

export interface TtsStats {
  audioDurationMs?: number;
  totalSamples?: number;
}

export interface TtsResponse {
  stats?: TtsStats;
  iterate(): AsyncIterable<{ outputArray: ArrayLike<number> }>;
}

export interface EmbedStats {
  total_time_ms?: number;
  tokens_per_second?: number;
  total_tokens?: number;
  backendDevice?: "cpu" | "gpu";
}

export interface EmbedResponse {
  stats?: EmbedStats;
  await(): Promise<Float32Array[][]>;
}

export interface TranscribeStats {
  audioDurationMs?: number;
  realTimeFactor?: number;
  tokensPerSecond?: number;
  totalTokens?: number;
  totalSegments?: number;
  whisperEncodeMs?: number;
  whisperDecodeMs?: number;
  encoderMs?: number;
  decoderMs?: number;
  melSpecMs?: number;
}

export interface TranscribeResponse {
  stats?: TranscribeStats;
  iterate(): AsyncIterable<Array<{ text: string }>>;
}
