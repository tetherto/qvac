/**
 * Declarative extraction of operation-level metrics from request/response data.
 * Used by operation wrappers to capture handler-specific profiling events.
 */

import {
  type CompletionStats,
  type OCRStats,
  type TranslationStats,
  type TranscribeStats,
  type EmbedStats,
  type TtsStats,
} from "@/schemas";
import { readModelExecutionMs } from "@/profiling/model-execution";
import type { ProfilingEvent, ProfilingEventKind } from "@/profiling/types";
import type { LoadModelProfilingMeta, DownloadStats } from "@/server/rpc/handlers/load-model/types";

export type MetricExtractor<T> = (
  data: T,
) => Record<string, number> | undefined;

export type TagExtractor<T> = (data: T) => Record<string, string> | undefined;

export interface OperationMetricsConfig<
  TRequest = unknown,
  TResponse = unknown,
> {
  op: string;
  kind: ProfilingEventKind;
  fromRequest?: MetricExtractor<TRequest>;
  fromFinalChunk?: MetricExtractor<TResponse>;
  fromResult?: MetricExtractor<TResponse>;
  getTags?: (request: TRequest) => Record<string, string>;
  getTagsFromResult?: TagExtractor<TResponse>;
}

const metricsRegistry = new Map<string, OperationMetricsConfig>();

export interface DownloadAssetProfilingMeta {
  sourceType?: string;
  downloadStats?: DownloadStats;
  totalDownloadTimeMs?: number;
}

interface DownloadStatsShape {
  downloadTimeMs?: number;
  totalBytesDownloaded?: number;
  downloadSpeedBps?: number;
}

type ResponseWithProfilingMeta<T> = { __profilingMeta?: T };


function extractDownloadStatsGauges(
  stats: DownloadStatsShape | undefined,
  gauges: Record<string, number>,
): void {
  if (stats?.downloadTimeMs !== undefined) {
    gauges["downloadTime"] = stats.downloadTimeMs;
  }
  if (stats?.totalBytesDownloaded !== undefined) {
    gauges["totalBytesDownloaded"] = stats.totalBytesDownloaded;
  }
  if (stats?.downloadSpeedBps !== undefined) {
    gauges["downloadSpeedBps"] = stats.downloadSpeedBps;
  }
}

export function registerOperationMetrics<TRequest, TResponse>(
  config: OperationMetricsConfig<TRequest, TResponse>,
): void {
  metricsRegistry.set(config.op, config as OperationMetricsConfig);
}

export function buildOperationEvent(
  op: string,
  profileId: string,
  ts: number,
  executionMs: number,
  request?: unknown,
  finalResponse?: unknown,
  ttfb?: number,
): ProfilingEvent | undefined {
  const config = metricsRegistry.get(op);
  if (!config) {
    return {
      ts,
      op,
      kind: "handler",
      profileId,
      ms: executionMs,
    };
  }

  const gauges: Record<string, number> = {};

  if (ttfb !== undefined) {
    gauges["ttfb"] = ttfb;
  }

  if (config.fromRequest && request) {
    const extracted = config.fromRequest(request);
    if (extracted) Object.assign(gauges, extracted);
  }

  if (config.fromFinalChunk && finalResponse) {
    const extracted = config.fromFinalChunk(finalResponse);
    if (extracted) Object.assign(gauges, extracted);
  }

  if (config.fromResult && finalResponse) {
    const extracted = config.fromResult(finalResponse);
    if (extracted) Object.assign(gauges, extracted);
  }

  const requestTags = config.getTags?.(request as never);
  const resultTags = config.getTagsFromResult?.(finalResponse as never);
  const tags = { ...requestTags, ...resultTags };

  const hasGauges = Object.keys(gauges).length > 0;
  const hasTags = Object.keys(tags).length > 0;

  const event: ProfilingEvent = {
    ts,
    op: config.op,
    kind: config.kind,
    profileId,
    ms: executionMs,
  };

  if (hasGauges) {
    event.gauges = gauges;
  }
  if (hasTags) {
    event.tags = tags;
  }

  return event;
}

registerOperationMetrics<{ modelId?: string }, { stats?: CompletionStats }>({
  op: "completionStream",
  kind: "handler",
  getTags: (req) => (req.modelId ? { modelId: req.modelId } : {}),
  fromFinalChunk: (res) => {
    const gauges: Record<string, number> = {};
    if (res.stats?.timeToFirstToken !== undefined)
      gauges["timeToFirstToken"] = res.stats.timeToFirstToken;
    if (res.stats?.tokensPerSecond !== undefined)
      gauges["tokensPerSecond"] = res.stats.tokensPerSecond;
    if (res.stats?.cacheTokens !== undefined)
      gauges["cacheTokens"] = res.stats.cacheTokens;
    const modelExecMs = readModelExecutionMs(res);
    if (modelExecMs !== undefined) gauges["modelExecutionTime"] = modelExecMs;
    return Object.keys(gauges).length > 0 ? gauges : undefined;
  },
});

registerOperationMetrics<{ modelId?: string }, { stats?: TranslationStats }>({
  op: "translate",
  kind: "handler",
  getTags: (req) => (req.modelId ? { modelId: req.modelId } : {}),
  fromFinalChunk: (res) => {
    const gauges: Record<string, number> = {};
    const modelExecMs = readModelExecutionMs(res);
    if (modelExecMs !== undefined) gauges["modelExecutionTime"] = modelExecMs;
    // Common stats
    if (res.stats?.totalTime !== undefined) gauges["totalTime"] = res.stats.totalTime;
    if (res.stats?.totalTokens !== undefined) gauges["totalTokens"] = res.stats.totalTokens;
    if (res.stats?.tokensPerSecond !== undefined) gauges["tokensPerSecond"] = res.stats.tokensPerSecond;
    if (res.stats?.timeToFirstToken !== undefined) gauges["timeToFirstToken"] = res.stats.timeToFirstToken;
    // NMT-specific
    if (res.stats?.decodeTime !== undefined) gauges["decodeTime"] = res.stats.decodeTime;
    if (res.stats?.encodeTime !== undefined) gauges["encodeTime"] = res.stats.encodeTime;
    // LLM-specific
    if (res.stats?.cacheTokens !== undefined) gauges["cacheTokens"] = res.stats.cacheTokens;
    return Object.keys(gauges).length > 0 ? gauges : undefined;
  },
});

registerOperationMetrics<{ modelId?: string }, { stats?: TranscribeStats }>({
  op: "transcribeStream",
  kind: "handler",
  getTags: (req) => (req.modelId ? { modelId: req.modelId } : {}),
  fromFinalChunk: (res) => {
    const gauges: Record<string, number> = {};
    const modelExecMs = readModelExecutionMs(res);
    if (modelExecMs !== undefined) gauges["modelExecutionTime"] = modelExecMs;
    // Common stats
    if (res.stats?.audioDuration !== undefined) gauges["audioDuration"] = res.stats.audioDuration;
    if (res.stats?.realTimeFactor !== undefined) gauges["realTimeFactor"] = res.stats.realTimeFactor;
    if (res.stats?.tokensPerSecond !== undefined) gauges["tokensPerSecond"] = res.stats.tokensPerSecond;
    if (res.stats?.totalTokens !== undefined) gauges["totalTokens"] = res.stats.totalTokens;
    if (res.stats?.totalSegments !== undefined) gauges["totalSegments"] = res.stats.totalSegments;
    // whisper-specific timings
    if (res.stats?.whisperEncodeTime !== undefined) gauges["whisperEncodeTime"] = res.stats.whisperEncodeTime;
    if (res.stats?.whisperDecodeTime !== undefined) gauges["whisperDecodeTime"] = res.stats.whisperDecodeTime;
    // parakeet-specific timings
    if (res.stats?.encoderTime !== undefined) gauges["encoderTime"] = res.stats.encoderTime;
    if (res.stats?.decoderTime !== undefined) gauges["decoderTime"] = res.stats.decoderTime;
    if (res.stats?.melSpecTime !== undefined) gauges["melSpecTime"] = res.stats.melSpecTime;
    return Object.keys(gauges).length > 0 ? gauges : undefined;
  },
});

registerOperationMetrics<{ modelId?: string }, { stats?: TtsStats }>({
  op: "textToSpeech",
  kind: "handler",
  getTags: (req) => (req.modelId ? { modelId: req.modelId } : {}),
  fromFinalChunk: (res) => {
    const gauges: Record<string, number> = {};
    const modelExecMs = readModelExecutionMs(res);
    if (modelExecMs !== undefined) gauges["modelExecutionTime"] = modelExecMs;
    if (res.stats?.audioDuration !== undefined) gauges["audioDuration"] = res.stats.audioDuration;
    if (res.stats?.totalSamples !== undefined) gauges["totalSamples"] = res.stats.totalSamples;
    return Object.keys(gauges).length > 0 ? gauges : undefined;
  },
});

registerOperationMetrics<{ modelId?: string }, { stats?: EmbedStats }>({
  op: "embed",
  kind: "handler",
  getTags: (req) => (req.modelId ? { modelId: req.modelId } : {}),
  fromResult: (res) => {
    const gauges: Record<string, number> = {};
    const modelExecMs = readModelExecutionMs(res);
    if (modelExecMs !== undefined) gauges["modelExecutionTime"] = modelExecMs;
    if (res.stats?.totalTime !== undefined) gauges["totalTime"] = res.stats.totalTime;
    if (res.stats?.tokensPerSecond !== undefined) gauges["tokensPerSecond"] = res.stats.tokensPerSecond;
    if (res.stats?.totalTokens !== undefined) gauges["totalTokens"] = res.stats.totalTokens;
    return Object.keys(gauges).length > 0 ? gauges : undefined;
  },
});

registerOperationMetrics<{ modelId?: string }, { stats?: OCRStats }>({
  op: "ocrStream",
  kind: "handler",
  getTags: (req) => (req.modelId ? { modelId: req.modelId } : {}),
  fromFinalChunk: (res) => {
    const gauges: Record<string, number> = {};
    if (res.stats?.detectionTime !== undefined)
      gauges["detectionTime"] = res.stats.detectionTime;
    if (res.stats?.recognitionTime !== undefined)
      gauges["recognitionTime"] = res.stats.recognitionTime;
    if (res.stats?.totalTime !== undefined)
      gauges["totalTime"] = res.stats.totalTime;
    const modelExecMs = readModelExecutionMs(res);
    if (modelExecMs !== undefined) gauges["modelExecutionTime"] = modelExecMs;
    return Object.keys(gauges).length > 0 ? gauges : undefined;
  },
});

registerOperationMetrics<{ modelId?: string; handler?: string }, unknown>({
  op: "pluginInvoke",
  kind: "handler",
  getTags: (req) => {
    const tags: Record<string, string> = {};
    if (req.modelId) tags["modelId"] = req.modelId;
    if (req.handler) tags["handler"] = req.handler;
    return tags;
  },
});

registerOperationMetrics<{ modelId?: string; handler?: string }, unknown>({
  op: "pluginInvokeStream",
  kind: "handler",
  getTags: (req) => {
    const tags: Record<string, string> = {};
    if (req.modelId) tags["modelId"] = req.modelId;
    if (req.handler) tags["handler"] = req.handler;
    return tags;
  },
});

registerOperationMetrics<
  { modelType?: string },
  ResponseWithProfilingMeta<LoadModelProfilingMeta>
>({
  op: "loadModel",
  kind: "handler",
  getTags: (req) => (req.modelType ? { modelType: req.modelType } : {}),
  getTagsFromResult: (res) => {
    const sourceType = res.__profilingMeta?.sourceType;
    return sourceType ? { sourceType } : undefined;
  },
  fromResult: (res) => {
    const meta = res.__profilingMeta;
    if (!meta) return undefined;

    const gauges: Record<string, number> = {};
    extractDownloadStatsGauges(meta.downloadStats, gauges);

    if (meta.modelInitializationTimeMs !== undefined) {
      gauges["modelInitializationTime"] = meta.modelInitializationTimeMs;
    }
    if (meta.totalLoadTimeMs !== undefined) {
      gauges["totalLoadTime"] = meta.totalLoadTimeMs;
    }

    return Object.keys(gauges).length > 0 ? gauges : undefined;
  },
});

registerOperationMetrics<
  unknown,
  ResponseWithProfilingMeta<DownloadAssetProfilingMeta>
>({
  op: "downloadAsset",
  kind: "handler",
  getTagsFromResult: (res) => {
    const sourceType = res.__profilingMeta?.sourceType;
    return sourceType ? { sourceType } : undefined;
  },
  fromResult: (res) => {
    const meta = res.__profilingMeta;
    if (!meta) return undefined;

    const gauges: Record<string, number> = {};
    extractDownloadStatsGauges(meta.downloadStats, gauges);

    if (meta.totalDownloadTimeMs !== undefined) {
      gauges["totalDownloadTime"] = meta.totalDownloadTimeMs;
    }

    return Object.keys(gauges).length > 0 ? gauges : undefined;
  },
});
