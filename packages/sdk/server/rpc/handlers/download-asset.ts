import type {
  DownloadAssetRequest,
  DownloadAssetResponse,
  ModelProgressUpdate,
} from "@/schemas";
import {
  PROFILING_KEY,
  OPERATION_EVENT_KEY,
  type OperationEvent,
} from "@/schemas";
import {
  resolveModelPath,
  resolveModelPathWithStats,
} from "@/server/rpc/handlers/load-model/resolve";
import type { DownloadStats } from "@/server/rpc/handlers/load-model/types";
import { nowMs, generateProfileId } from "@/profiling/clock";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function handleDownloadAsset(
  request: DownloadAssetRequest,
  progressCallback?: (update: ModelProgressUpdate) => void,
): Promise<DownloadAssetResponse> {
  const { assetSrc, seed } = request;

  const profilingMeta = (request as Record<string, unknown>)[PROFILING_KEY] as
    | { enabled?: boolean; id?: string }
    | undefined;
  const profilingEnabled = profilingMeta?.enabled !== false && !!profilingMeta;

  try {
    const totalDownloadStart = profilingEnabled ? nowMs() : 0;

    let sourceType: string | undefined;
    let downloadStats: DownloadStats | undefined;

    if (profilingEnabled) {
      const result = await resolveModelPathWithStats(
        assetSrc,
        progressCallback,
        seed,
      );
      sourceType = result.sourceType;
      downloadStats = result.downloadStats;
    } else {
      await resolveModelPath(assetSrc, progressCallback, seed);
    }

    const response: DownloadAssetResponse = {
      type: "downloadAsset",
      success: true,
      assetId: assetSrc,
    };

    if (profilingEnabled) {
      const totalDownloadTimeMs = nowMs() - totalDownloadStart;
      const profileId = profilingMeta?.id ?? generateProfileId();

      const gauges: Record<string, number> = {
        totalDownloadTime: totalDownloadTimeMs,
      };
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
      }

      const tags: Record<string, string> = {};
      if (sourceType) {
        tags["sourceType"] = sourceType;
      }
      if (downloadStats?.cacheHit !== undefined) {
        tags["cacheHit"] = downloadStats.cacheHit ? "true" : "false";
      }

      const operationEvent: OperationEvent = {
        op: "downloadAsset",
        kind: "handler",
        ms: totalDownloadTimeMs,
        profileId,
        gauges: Object.keys(gauges).length > 0 ? gauges : undefined,
        tags: Object.keys(tags).length > 0 ? tags : undefined,
      };

      (response as DownloadAssetResponse & { [OPERATION_EVENT_KEY]?: OperationEvent })[OPERATION_EVENT_KEY] = operationEvent;
    }

    return response;
  } catch (error: unknown) {
    logger.error("Error downloading asset:", error);
    return {
      type: "downloadAsset",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
