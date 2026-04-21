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
  enable: (options?: ProfilerRuntimeOptions) => controller.enable(options),
  disable: () => controller.disable(),
  isEnabled: () => controller.isEnabled(),
  exportJSON: (options?: { includeRecentEvents?: boolean }): ProfilerExport =>
    exporters.exportJSON(options),
  exportTable: () => exporters.exportTable(),
  exportSummary: () => exporters.exportSummary(),
  onRecord: (callback: (event: ProfilingEvent) => void) =>
    controller.onRecord(callback),
  getConfig: () => controller.getEffectiveConfig(),
  getAggregates: (): Record<string, AggregatedStats> =>
    controller.getAggregates(),
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
