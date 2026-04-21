export type ProfilingEventKind =
  | "rpc"
  | "handler"
  | "download"
  | "load"
  | "delegation";

export interface ProfilingEvent {
  /** Monotonic timestamp in milliseconds */
  ts: number;
  /** Operation name (e.g., `"completion"`, `"loadModel"`) */
  op: string;
  /** Event category */
  kind: ProfilingEventKind;
  /** Unique identifier for the profiling session */
  profileId?: string;
  /** Sub-phase within the operation (e.g., `"rpc.send"`, `"handler.run"`) */
  phase?: string;
  /** Duration in milliseconds */
  ms?: number;
  /** Count metric (e.g., tokens, chunks) */
  count?: number;
  /** Byte count metric */
  bytes?: number;
  /** Numeric gauges (e.g., throughput, token counters) */
  gauges?: Record<string, number>;
  /** String tags (e.g., `handlerType`, `sourceType`, `modelId`) */
  tags?: Record<string, string>;
}

export interface ProfilerRuntimeOptions {
  /**
   * Profiling detail level — `"verbose"` retains recent events
   * @default "summary"
   */
  mode?: "summary" | "verbose";
  /**
   * Include server-side timing breakdown in profiling data
   * @default false
   */
  includeServerBreakdown?: boolean;
  /**
   * Only profile operations whose names match these filters (empty = all)
   * @default []
   */
  operationFilters?: string[];
}

export interface AggregatedStats {
  /** Number of recorded events */
  count: number;
  /** Minimum duration in milliseconds */
  min: number;
  /** Maximum duration in milliseconds */
  max: number;
  /** Average duration in milliseconds */
  avg: number;
  /** Total accumulated duration in milliseconds */
  sum: number;
  /** Most recent duration in milliseconds */
  last: number;
}

export interface ProfilerExport {
  /** Snapshot of the profiler configuration at export time */
  config: {
    /** Whether profiling was enabled */
    enabled: boolean;
    /** Profiling mode */
    mode: "summary" | "verbose";
    /** Whether server breakdown was enabled */
    includeServerBreakdown: boolean;
    /** Active operation filters */
    operationFilters: string[];
    /** Max recent events setting */
    maxRecentEvents: number;
  };
  /** Aggregated statistics keyed by operation name */
  aggregates: Record<string, AggregatedStats>;
  /** Recent profiling events (only when `includeRecentEvents: true`) */
  recentEvents?: ProfilingEvent[];
  /** Monotonic timestamp of the export */
  exportedAt: number;
}

export interface LoadTimingStats {
  modelInitializationTimeMs?: number;
  totalLoadTimeMs?: number;
}
