/**
 * Central state management for profiling enablement, configuration, and recording.
 *
 * Precedence (highest to lowest):
 * 1. Per-call override
 * 2. Runtime API (enable/disable)
 * 3. Disabled default
 */

import type { ProfilerMode, PerCallProfiling } from "@/schemas";
import { getGlobalSingleton } from "@/utils/global-singleton";
import type {
  ProfilerRuntimeOptions,
  ProfilingEvent,
  AggregatedStats,
} from "./types";
import {
  createAggregator,
  recordEvent as aggregatorRecord,
  getAggregates as aggregatorGetAggregates,
  getRecentEvents as aggregatorGetRecentEvents,
  clearAggregator,
  setMaxRecentEvents,
} from "./aggregator";
import { nowMs, generateProfileId } from "./clock";

export interface ResolvedProfilerConfig {
  enabled: boolean;
  mode: ProfilerMode;
  includeServerBreakdown: boolean;
  operationFilters: string[];
  maxRecentEvents: number;
}

const DEFAULT_CONFIG: ResolvedProfilerConfig = {
  enabled: false,
  mode: "summary",
  includeServerBreakdown: false,
  operationFilters: [],
  maxRecentEvents: 1000,
};

type RecordCallback = (event: ProfilingEvent) => void;

interface ControllerState {
  runtimeOverride: boolean | undefined;
  runtimeOptions: ProfilerRuntimeOptions;
  onRecordCallbacks: RecordCallback[];
  initialized: boolean;
}

const CONTROLLER_STATE_KEY = Symbol.for("@qvac/sdk:profiler-controller-state");

function getControllerState(): ControllerState {
  const state = getGlobalSingleton(CONTROLLER_STATE_KEY, () => {
    return {
      runtimeOverride: undefined,
      runtimeOptions: {},
      onRecordCallbacks: [],
      initialized: false,
    };
  });
  if (!state.initialized) {
    createAggregator(DEFAULT_CONFIG.maxRecentEvents);
    state.initialized = true;
  }

  return state;
}

export function enable(options?: ProfilerRuntimeOptions): void {
  const state = getControllerState();
  state.runtimeOverride = true;
  state.runtimeOptions = options ? { ...options } : {};
  clearAggregator();
  setMaxRecentEvents(DEFAULT_CONFIG.maxRecentEvents);
}

export function disable(): void {
  const state = getControllerState();
  state.runtimeOverride = false;
  state.runtimeOptions = {};
  setMaxRecentEvents(DEFAULT_CONFIG.maxRecentEvents);
}

export function isEnabled(): boolean {
  const state = getControllerState();
  return state.runtimeOverride ?? false;
}

export function getEffectiveConfig(): ResolvedProfilerConfig {
  const state = getControllerState();
  return {
    enabled: isEnabled(),
    mode: state.runtimeOptions.mode ?? DEFAULT_CONFIG.mode,
    includeServerBreakdown:
      state.runtimeOptions.includeServerBreakdown ??
      DEFAULT_CONFIG.includeServerBreakdown,
    operationFilters: [
      ...(state.runtimeOptions.operationFilters ?? DEFAULT_CONFIG.operationFilters),
    ],
    maxRecentEvents: DEFAULT_CONFIG.maxRecentEvents,
  };
}

export function shouldProfile(
  operation: string,
  perCallOptions?: PerCallProfiling,
): boolean {
  if (perCallOptions?.enabled !== undefined) {
    return perCallOptions.enabled;
  }

  if (!isEnabled()) {
    return false;
  }

  const config = getEffectiveConfig();
  if (config.operationFilters.length > 0) {
    return config.operationFilters.includes(operation);
  }

  return true;
}

export function shouldIncludeServerBreakdown(
  perCallOptions?: PerCallProfiling,
): boolean {
  if (perCallOptions?.includeServerBreakdown !== undefined) {
    return perCallOptions.includeServerBreakdown;
  }
  return getEffectiveConfig().includeServerBreakdown;
}

export function generateId(): string {
  return generateProfileId();
}

export function record(event: ProfilingEvent): void {
  const state = getControllerState();
  let eventWithTs = event;
  if (event.ts === undefined) {
    eventWithTs = { ...event, ts: nowMs() };
  }

  const storeInBuffer = getEffectiveConfig().mode === "verbose";
  aggregatorRecord(eventWithTs, storeInBuffer);

  for (const cb of state.onRecordCallbacks) {
    try {
      cb(eventWithTs);
    } catch {
      // Callback errors should not break profiling
    }
  }
}

/** Returns unsubscribe function. */
export function onRecord(callback: RecordCallback): () => void {
  const state = getControllerState();
  state.onRecordCallbacks.push(callback);
  return () => {
    const idx = state.onRecordCallbacks.indexOf(callback);
    if (idx >= 0) {
      state.onRecordCallbacks.splice(idx, 1);
    }
  };
}

export function getAggregates(): Record<string, AggregatedStats> {
  return aggregatorGetAggregates();
}

export function getRecentEvents(): ProfilingEvent[] {
  return aggregatorGetRecentEvents();
}

export function clear(): void {
  clearAggregator();
}
