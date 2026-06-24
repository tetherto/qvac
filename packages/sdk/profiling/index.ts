/**
 * QVAC SDK Profiler
 *
 * @example
 * ```ts
 * import { profiler } from "@qvac/sdk";
 *
 * profiler.enable({ mode: "summary" });
 * // ... run SDK operations ...
 * console.log(profiler.exportTable());
 * profiler.disable();
 * ```
 */

import * as controller from "./controller";
import * as exporters from "./exporters";
import type {
  ProfilerRuntimeOptions,
  ProfilingEvent,
  ProfilerExport,
  AggregatedStats,
} from "./types";

export const profiler = {
  /**
   * Enables profiling and resets all previously aggregated data.
   *
   * @param options - Optional runtime options (profiling mode, server breakdown, operation filters, ring-buffer capacity).
   */
  enable: (options?: ProfilerRuntimeOptions) => controller.enable(options),

  /**
   * Disables profiling. New SDK operations will no longer be recorded.
   */
  disable: () => controller.disable(),

  /**
   * Returns whether profiling is currently enabled.
   *
   * @returns `true` when profiling is currently enabled, `false` otherwise.
   */
  isEnabled: () => controller.isEnabled(),

  /**
   * Exports profiling data as a structured JSON object suitable for machine consumption.
   *
   * @param options - Export options.
   * @param options.includeRecentEvents - When `true`, includes the ring buffer of recent events in the export (only populated when profiler was enabled in `"verbose"` mode).
   * @returns A `ProfilerExport` snapshot of aggregated stats and (optionally) recent events.
   */
  exportJSON: (options?: { includeRecentEvents?: boolean }): ProfilerExport =>
    exporters.exportJSON(options),

  /**
   * Exports aggregated stats as a formatted ASCII table suitable for terminal output.
   *
   * @returns A multi-line string rendering of the aggregated stats table.
   */
  exportTable: () => exporters.exportTable(),

  /**
   * Exports a short, human-readable summary string of the aggregated stats.
   *
   * @returns A one-paragraph summary of the profiling data.
   */
  exportSummary: () => exporters.exportSummary(),

  /**
   * Registers a listener for profiling events; returns an unsubscribe function.
   *
   * @param callback - Invoked once per recorded profiling event.
   * @returns An unsubscribe function; call it to remove the listener.
   */
  onRecord: (callback: (event: ProfilingEvent) => void) =>
    controller.onRecord(callback),

  /**
   * Returns the current effective profiler configuration.
   *
   * @returns The effective `ResolvedProfilerConfig` (defaults merged with user overrides).
   */
  getConfig: () => controller.getEffectiveConfig(),

  /**
   * Returns all aggregated stats keyed by operation name.
   *
   * @returns A record of `AggregatedStats` keyed by operation name.
   */
  getAggregates: (): Record<string, AggregatedStats> =>
    controller.getAggregates(),

  /**
   * Clears all aggregated data and the recent-events ring buffer.
   */
  clear: () => controller.clear(),
};

export type {
  ProfilerRuntimeOptions,
  ProfilingEvent,
  ProfilerExport,
  AggregatedStats,
  ProfilingEventKind,
} from "./types";
export type { ProfilerMode } from "@/schemas";
export { nowMs } from "./clock";
export {
  record,
  shouldProfile,
  shouldIncludeServerBreakdown,
  generateId,
  isEnabled,
  type ResolvedProfilerConfig,
} from "./controller";
export {
  createProfilingMeta,
  createProfilingDisabledMeta,
  injectProfilingMetaIntoObject,
  extractProfilingMeta,
  stripProfilingMeta,
} from "./envelope";
export {
  recordPhase,
  recordFailure,
  recordServerBreakdownPhases,
  recordDelegationBreakdownPhases,
  type BaseTimings,
  type BaseEvent,
} from "./events";
