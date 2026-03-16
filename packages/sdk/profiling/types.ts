export type ProfilingEventKind =
  | "rpc"
  | "handler"
  | "download"
  | "load"
  | "delegation";

export interface ProfilingEvent {
  /** Timestamp when event was recorded (monotonic ms) */
  ts: number;
  op: string;
  kind: ProfilingEventKind;
  profileId?: string;
  phase?: string;
  ms?: number;
  /** Count (e.g., chunks, tokens) */
  count?: number;
  bytes?: number;
  /** Numeric gauges (e.g., throughput, token counters) */
  gauges?: Record<string, number>;
  /** String tags (e.g., handlerType, sourceType, modelId) */
  tags?: Record<string, string>;
}

export interface ProfilerRuntimeOptions {
  mode?: "summary" | "verbose";
  includeServerBreakdown?: boolean;
  operationFilters?: string[];
}

export interface AggregatedStats {
  count: number;
  min: number;
  max: number;
  avg: number;
  sum: number;
  last: number;
}

export interface ProfilerExport {
  config: {
    enabled: boolean;
    mode: "summary" | "verbose";
    includeServerBreakdown: boolean;
    operationFilters: string[];
    maxRecentEvents: number;
  };
  aggregates: Record<string, AggregatedStats>;
  recentEvents?: ProfilingEvent[];
  exportedAt: number;
}
