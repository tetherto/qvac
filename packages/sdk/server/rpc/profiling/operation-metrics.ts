/**
 * Declarative extraction of operation-level metrics from request/response data.
 * Used by operation wrappers to capture handler-specific profiling events.
 */

import type { CompletionStats, TranslationStats, OCRStats } from "@/schemas";
import type { ProfilingEvent, ProfilingEventKind } from "@/profiling/types";

export type MetricExtractor<T> = (
  data: T,
) => Record<string, number> | undefined;

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
}

const metricsRegistry = new Map<string, OperationMetricsConfig>();

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

  const tags = config.getTags?.(request as never);
  const hasGauges = Object.keys(gauges).length > 0;
  const hasTags = tags && Object.keys(tags).length > 0;

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
    if (!res.stats) return undefined;
    const gauges: Record<string, number> = {};
    if (res.stats.timeToFirstToken !== undefined)
      gauges["timeToFirstToken"] = res.stats.timeToFirstToken;
    if (res.stats.tokensPerSecond !== undefined)
      gauges["tokensPerSecond"] = res.stats.tokensPerSecond;
    if (res.stats.cacheTokens !== undefined)
      gauges["cacheTokens"] = res.stats.cacheTokens;
    return Object.keys(gauges).length > 0 ? gauges : undefined;
  },
});

registerOperationMetrics<{ modelId?: string }, { stats?: TranslationStats }>({
  op: "translate",
  kind: "handler",
  getTags: (req) => (req.modelId ? { modelId: req.modelId } : {}),
  fromFinalChunk: (res) => {
    if (!res.stats) return undefined;
    const gauges: Record<string, number> = {};
    if (res.stats.processedTokens !== undefined)
      gauges["processedTokens"] = res.stats.processedTokens;
    if (res.stats.processingTime !== undefined)
      gauges["processingTime"] = res.stats.processingTime;
    return Object.keys(gauges).length > 0 ? gauges : undefined;
  },
});

registerOperationMetrics<{ modelId?: string }, unknown>({
  op: "transcribeStream",
  kind: "handler",
  getTags: (req) => (req.modelId ? { modelId: req.modelId } : {}),
});

registerOperationMetrics<{ modelId?: string }, unknown>({
  op: "textToSpeech",
  kind: "handler",
  getTags: (req) => (req.modelId ? { modelId: req.modelId } : {}),
});

registerOperationMetrics<{ modelId?: string }, unknown>({
  op: "embed",
  kind: "handler",
  getTags: (req) => (req.modelId ? { modelId: req.modelId } : {}),
});

registerOperationMetrics<{ modelId?: string }, { stats?: OCRStats }>({
  op: "ocrStream",
  kind: "handler",
  getTags: (req) => (req.modelId ? { modelId: req.modelId } : {}),
  fromFinalChunk: (res) => {
    if (!res.stats) return undefined;
    const gauges: Record<string, number> = {};
    if (res.stats.detectionTime !== undefined)
      gauges["detectionTime"] = res.stats.detectionTime;
    if (res.stats.recognitionTime !== undefined)
      gauges["recognitionTime"] = res.stats.recognitionTime;
    if (res.stats.totalTime !== undefined)
      gauges["totalTime"] = res.stats.totalTime;
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
