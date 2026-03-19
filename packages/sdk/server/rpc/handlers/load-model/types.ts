import type { SourceType } from "@/schemas";

export interface DownloadStats {
  downloadTimeMs?: number;
  totalBytesDownloaded?: number;
  downloadSpeedBps?: number;
  checksumValidationTimeMs?: number;
  cacheHit?: boolean;
}

export interface ResolveResult {
  path: string;
  sourceType: SourceType;
  downloadStats?: DownloadStats;
}

export interface DownloadResult {
  path: string;
  stats?: DownloadStats;
}

export interface DownloadMetricsHooks {
  markCacheHit: () => void;
  markCacheMiss: () => void;
  addChecksumValidationTimeMs: (durationMs: number) => void;
}

export interface LoadModelProfilingMeta {
  sourceType?: string;
  downloadStats?: DownloadStats;
  modelInitializationTimeMs?: number;
  totalLoadTimeMs?: number;
}
