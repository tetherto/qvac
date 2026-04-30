import type { SourceType } from "@/schemas";

export interface DownloadStats {
  downloadTimeMs?: number;
  totalBytesDownloaded?: number;
  downloadSpeedBps?: number;
  checksumValidationTimeMs?: number;
  cacheHit?: boolean;
  sharedTransfer?: boolean;
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

export interface DownloadHooks {
  onDownloadKey?: (key: string) => void;
  markCacheHit?: () => void;
  markCacheMiss?: () => void;
  markSharedTransfer?: () => void;
  addChecksumValidationTimeMs?: (durationMs: number) => void;
}

export interface LoadModelProfilingMeta {
  sourceType?: string;
  downloadStats?: DownloadStats;
  modelInitializationTimeMs?: number;
  totalLoadTimeMs?: number;
}

export function buildDownloadProfilingFields(
  downloadStats: DownloadStats | undefined,
  sourceType?: string,
): { gauges: Record<string, number>; tags: Record<string, string> } {
  const gauges: Record<string, number> = {};
  const tags: Record<string, string> = {};

  if (downloadStats) {
    if (downloadStats.downloadTimeMs !== undefined) {
      gauges["downloadTime"] = downloadStats.downloadTimeMs;
    }
    if (downloadStats.totalBytesDownloaded !== undefined) {
      gauges["totalBytesDownloaded"] = downloadStats.totalBytesDownloaded;
    }
    if (downloadStats.downloadSpeedBps !== undefined) {
      gauges["downloadSpeedBps"] = downloadStats.downloadSpeedBps;
    }
    if (downloadStats.checksumValidationTimeMs !== undefined) {
      gauges["checksumValidationTime"] = downloadStats.checksumValidationTimeMs;
    }
    if (downloadStats.cacheHit !== undefined) {
      tags["cacheHit"] = downloadStats.cacheHit ? "true" : "false";
    }
    if (downloadStats.sharedTransfer) {
      tags["sharedTransfer"] = "true";
    }
  }

  if (sourceType) {
    tags["sourceType"] = sourceType;
  }

  return { gauges, tags };
}

