/**
 * Singleton object that collects and exports profiling data for SDK operations.
 *
 * @example
 * ```typescript
 * import { profiler, completion, loadModel } from "@qvac/sdk";
 *
 * profiler.enable({ mode: "verbose", includeServerBreakdown: true });
 *
 * const modelId = await loadModel({
 *   modelSrc: "/path/to/model.gguf",
 *   modelType: "llm",
 * });
 *
 * const result = completion({
 *   modelId,
 *   history: [{ role: "user", content: "Hello!" }],
 * });
 *
 * await result.text;
 *
 * console.log(profiler.exportTable());
 *
 * const json = profiler.exportJSON({ includeRecentEvents: true });
 * console.log("Aggregates:", json.aggregates);
 *
 * profiler.clear();
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
   * @param options - Runtime profiler options
   * @returns void
   */
  enable: (options?: ProfilerRuntimeOptions) => controller.enable(options),
  /**
   * Disables profiling. New SDK operations will no longer be recorded.
   *
   * @returns void
   */
  disable: () => controller.disable(),
  /**
   * Returns whether profiling is currently enabled.
   *
   * @returns `true` if profiling is enabled, `false` otherwise.
   */
  isEnabled: () => controller.isEnabled(),
  /**
   * Exports profiling data as a structured JSON object.
   *
   * @param options - Export options
   * @param options.includeRecentEvents - Include recent events in the export
   *   (only available in `"verbose"` mode)
   * @returns Structured JSON object containing configuration snapshot,
   *   aggregated statistics, and optionally recent events.
   */
  exportJSON: (options?: { includeRecentEvents?: boolean }): ProfilerExport =>
    exporters.exportJSON(options),
  /**
   * Exports aggregated stats as a formatted ASCII table suitable for console
   * output.
   *
   * @returns Formatted ASCII table of all aggregated profiling data.
   */
  exportTable: () => exporters.exportTable(),
  /**
   * Exports a human-readable summary of all aggregated profiling data.
   *
   * @returns Human-readable summary string.
   */
  exportSummary: () => exporters.exportSummary(),
  /**
   * Registers a listener that is called for every profiling event.
   *
   * @param callback - Function called with each profiling event
   * @returns An unsubscribe function. Call it to stop receiving events.
   */
  onRecord: (callback: (event: ProfilingEvent) => void) =>
    controller.onRecord(callback),
  /**
   * Returns the current effective profiler configuration.
   *
   * @returns The active profiler configuration including mode, filters, and
   *   max recent events.
   */
  getConfig: () => controller.getEffectiveConfig(),
  /**
   * Returns all aggregated stats keyed by operation name.
   *
   * @returns All aggregated stats keyed by operation name.
   */
  getAggregates: (): Record<string, AggregatedStats> =>
    controller.getAggregates(),
  /**
   * Clears all aggregated data and recent events. Does not disable profiling.
   *
   * @returns void
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
