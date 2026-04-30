import type { ModelProgressUpdate } from "@/schemas";
import type { DownloadStats, DownloadResult, DownloadHooks, ResolveResult } from "./types";
import { downloadModelFromHttp } from "./http";
import { downloadModelFromRegistry } from "./registry";
import { downloadModelFromHyperdrive } from "./hyperdrive";
import { nowMs } from "@/profiling";

interface StatsCollector {
  maxBytesDownloaded: number;
  startTimeMs: number;
  cacheHit: boolean | undefined;
  sharedTransfer: boolean;
  checksumValidationTimeMsTotal: number;
}

function createStatsCollector(): StatsCollector {
  return {
    maxBytesDownloaded: 0,
    startTimeMs: nowMs(),
    cacheHit: undefined,
    sharedTransfer: false,
    checksumValidationTimeMsTotal: 0,
  };
}

function createStatsHooks(collector: StatsCollector): DownloadHooks {
  return {
    markCacheHit: () => {
      if (collector.cacheHit === undefined) {
        collector.cacheHit = true;
        collector.maxBytesDownloaded = 0;
      }
    },
    markCacheMiss: () => {
      collector.cacheHit = false;
    },
    markSharedTransfer: () => {
      collector.sharedTransfer = true;
    },
    addChecksumValidationTimeMs: (durationMs: number) => {
      collector.checksumValidationTimeMsTotal += durationMs;
    },
  };
}

function wrapProgressCallback(
  collector: StatsCollector,
  originalCallback?: (progress: ModelProgressUpdate) => void,
): (progress: ModelProgressUpdate) => void {
  return (progress: ModelProgressUpdate) => {
    // Don't track bytes for cache hits (they're not real network transfer)
    if (collector.cacheHit !== true) {
      const downloaded =
        progress.fileSetInfo?.overallDownloaded ??
        progress.shardInfo?.overallDownloaded ??
        progress.downloaded ??
        0;

      collector.maxBytesDownloaded = Math.max(
        collector.maxBytesDownloaded,
        downloaded,
      );
    }

    originalCallback?.(progress);
  };
}

function computeStats(collector: StatsCollector): DownloadStats | undefined {
  const downloadTimeMs = nowMs() - collector.startTimeMs;
  const totalBytesDownloaded = collector.maxBytesDownloaded;

  const stats: DownloadStats = {};

  if (collector.sharedTransfer) {
    stats.sharedTransfer = true;
  }

  if (collector.cacheHit !== undefined) {
    stats.cacheHit = collector.cacheHit;
  }

  if (collector.checksumValidationTimeMsTotal > 0) {
    stats.checksumValidationTimeMs = collector.checksumValidationTimeMsTotal;
  }

  if (collector.cacheHit === true) {
    return Object.keys(stats).length > 0 ? stats : undefined;
  }

  if (collector.sharedTransfer) {
    if (downloadTimeMs > 0) {
      stats.downloadTimeMs = downloadTimeMs;
    }
    return Object.keys(stats).length > 0 ? stats : undefined;
  }

  if (totalBytesDownloaded > 0) {
    stats.downloadTimeMs = downloadTimeMs;
    stats.totalBytesDownloaded = totalBytesDownloaded;

    if (downloadTimeMs > 0) {
      stats.downloadSpeedBps = (totalBytesDownloaded * 1000) / downloadTimeMs;
    }
  }

  return Object.keys(stats).length > 0 ? stats : undefined;
}

export async function downloadModelFromHttpWithStats(
  url: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  downloadHooks?: DownloadHooks,
): Promise<DownloadResult> {
  const collector = createStatsCollector();
  const hooks: DownloadHooks = { ...downloadHooks, ...createStatsHooks(collector) };
  const wrappedCallback = wrapProgressCallback(collector, progressCallback);
  const path = await downloadModelFromHttp(url, wrappedCallback, hooks);
  const stats = computeStats(collector);
  return stats ? { path, stats } : { path };
}

export async function downloadModelFromRegistryWithStats(
  registryPath: string,
  registrySource: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  expectedChecksum?: string,
  downloadHooks?: DownloadHooks,
): Promise<DownloadResult> {
  const collector = createStatsCollector();
  const hooks: DownloadHooks = { ...downloadHooks, ...createStatsHooks(collector) };
  const wrappedCallback = wrapProgressCallback(collector, progressCallback);
  const path = await downloadModelFromRegistry(
    registryPath,
    registrySource,
    wrappedCallback,
    expectedChecksum,
    hooks,
  );
  const stats = computeStats(collector);
  return stats ? { path, stats } : { path };
}

export async function downloadModelFromHyperdriveWithStats(
  hyperdriveKey: string,
  modelFileName: string,
  seed?: boolean,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  downloadHooks?: DownloadHooks,
): Promise<DownloadResult> {
  const collector = createStatsCollector();
  const hooks: DownloadHooks = { ...downloadHooks, ...createStatsHooks(collector) };
  const wrappedCallback = wrapProgressCallback(collector, progressCallback);
  const path = await downloadModelFromHyperdrive(
    hyperdriveKey,
    modelFileName,
    seed,
    wrappedCallback,
    hooks,
  );
  const stats = computeStats(collector);
  return stats ? { path, stats } : { path };
}

export function mergeDownloadStats(
  results: ResolveResult[],
): DownloadStats | undefined {
  const stats = results
    .map((r) => r.downloadStats)
    .filter((s): s is DownloadStats => s !== undefined);

  if (stats.length === 0) return undefined;

  const downloadTimeMs = Math.max(
    ...stats.map((s) => s.downloadTimeMs ?? 0),
  );

  const totalBytesDownloaded = stats.reduce(
    (sum, s) => sum + (s.totalBytesDownloaded ?? 0),
    0,
  );

  const checksumValidationTimeMs = stats.reduce(
    (sum, s) => sum + (s.checksumValidationTimeMs ?? 0),
    0,
  );

  const cacheHitValues = stats
    .map((s) => s.cacheHit)
    .filter((v): v is boolean => v !== undefined);

  const merged: DownloadStats = {};

  if (downloadTimeMs > 0) merged.downloadTimeMs = downloadTimeMs;
  if (totalBytesDownloaded > 0) merged.totalBytesDownloaded = totalBytesDownloaded;
  if (downloadTimeMs > 0 && totalBytesDownloaded > 0) {
    merged.downloadSpeedBps = (totalBytesDownloaded * 1000) / downloadTimeMs;
  }
  if (checksumValidationTimeMs > 0) merged.checksumValidationTimeMs = checksumValidationTimeMs;
  if (cacheHitValues.length > 0) merged.cacheHit = cacheHitValues.every(Boolean);
  if (stats.some((s) => s.sharedTransfer)) merged.sharedTransfer = true;

  return Object.keys(merged).length > 0 ? merged : undefined;
}

