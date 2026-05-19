import type { SourceType } from "@/schemas";
import type { AbortSignal } from "bare-abort-controller";
import type { DisposableScope } from "@/server/bare/runtime/disposable-scope";

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

/**
 * Internal request binding threaded through `DownloadHooks` so the
 * download manager's `startOrJoinDownload` can register a per-subscriber
 * cancel hook against the caller's `RequestContext`. The binding's
 * fields mirror the registry context's surface area: `signal` is wired
 * to a subscriber-removing listener, `scope` registers the idempotent
 * cleanup, and `requestId` lets `cancelTransfer` (legacy entry point)
 * route cancels through `registry.cancel(...)` rather than reaching
 * into the transfer directly.
 */
export interface DownloadRequestBinding {
  signal: AbortSignal;
  scope: DisposableScope;
  requestId: string;
}

export interface DownloadHooks {
  onDownloadKey?: (key: string) => void;
  markCacheHit?: () => void;
  markCacheMiss?: () => void;
  markSharedTransfer?: () => void;
  addChecksumValidationTimeMs?: (durationMs: number) => void;
  /**
   * When set, `startOrJoinDownload` attaches a per-subscriber cancel
   * listener bound to this request. `registry.cancel({ requestId })`
   * aborts only this subscriber; the transfer keeps running for siblings
   * joined on the same `downloadKey` until the last subscriber leaves.
   */
  requestBinding?: DownloadRequestBinding;
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

