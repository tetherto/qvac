import type { ModelProgressUpdate } from "@/schemas";
import type { DownloadStats, DownloadResult, DownloadMetricsHooks } from "./types";
import { downloadModelFromHttp } from "./http";
import { downloadModelFromRegistry } from "./registry";
import { downloadModelFromHyperdrive } from "./hyperdrive";
import { nowMs } from "@/profiling";

interface StatsCollector {
  maxBytesDownloaded: number;
  startTimeMs: number;
  cacheHit: boolean | undefined;
  checksumValidationTimeMsTotal: number;
}

function createStatsCollector(): StatsCollector {
  return {
    maxBytesDownloaded: 0,
    startTimeMs: nowMs(),
    cacheHit: undefined,
    checksumValidationTimeMsTotal: 0,
  };
}

function createHooks(collector: StatsCollector): DownloadMetricsHooks {
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
        progress.onnxInfo?.overallDownloaded ??
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

  if (collector.cacheHit !== undefined) {
    stats.cacheHit = collector.cacheHit;
  }

  if (collector.checksumValidationTimeMsTotal > 0) {
    stats.checksumValidationTimeMs = collector.checksumValidationTimeMsTotal;
  }

  if (collector.cacheHit === true) {
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
): Promise<DownloadResult> {
  const collector = createStatsCollector();
  const hooks = createHooks(collector);
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
): Promise<DownloadResult> {
  const collector = createStatsCollector();
  const hooks = createHooks(collector);
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
): Promise<DownloadResult> {
  const collector = createStatsCollector();
  const hooks = createHooks(collector);
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
