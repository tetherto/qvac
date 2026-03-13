/**
 * Accumulates profiling statistics and maintains a bounded buffer of recent events.
 * Uses a ring buffer for O(1) event insertion.
 */

import type { ProfilingEvent, AggregatedStats } from "./types";
import { getGlobalSingleton } from "@/utils/global-singleton";
import {
  createRingBuffer,
  ringBufferPush,
  ringBufferToArray,
  ringBufferClear,
  ringBufferResize,
  ringBufferDroppedCount,
  type RingBufferState,
} from "./ring-buffer";

const DEFAULT_MAX_RECENT_EVENTS = 1000;

interface RollingStatsState {
  count: number;
  min: number;
  max: number;
  sum: number;
  last: number;
}

interface AggregatorState {
  stats: Map<string, RollingStatsState>;
  eventBuffer: RingBufferState<ProfilingEvent>;
}

const AGGREGATOR_STATE_KEY = Symbol.for("@qvac/sdk:profiler-aggregator-state");

function getAggregatorState(): AggregatorState {
  return getGlobalSingleton(AGGREGATOR_STATE_KEY, () => {
    return {
      stats: new Map<string, RollingStatsState>(),
      eventBuffer: createRingBuffer(DEFAULT_MAX_RECENT_EVENTS),
    };
  });
}

export function createAggregator(
  maxRecentEvents: number = DEFAULT_MAX_RECENT_EVENTS,
): void {
  const state = getAggregatorState();
  state.stats = new Map();
  state.eventBuffer = createRingBuffer(maxRecentEvents);
}

function recordStats(key: string, value: number): void {
  const aggregator = getAggregatorState();
  let statsState = aggregator.stats.get(key);
  if (!statsState) {
    statsState = {
      count: 0,
      min: Infinity,
      max: -Infinity,
      sum: 0,
      last: 0,
    };
    aggregator.stats.set(key, statsState);
  }

  statsState.count++;
  statsState.sum += value;
  statsState.last = value;
  if (value < statsState.min) statsState.min = value;
  if (value > statsState.max) statsState.max = value;
}

function getStats(state: RollingStatsState): AggregatedStats {
  return {
    count: state.count,
    min: state.count > 0 ? state.min : 0,
    max: state.count > 0 ? state.max : 0,
    avg: state.count > 0 ? state.sum / state.count : 0,
    sum: state.sum,
    last: state.last,
  };
}

export function recordEvent(
  event: ProfilingEvent,
  storeInBuffer: boolean = true,
): void {
  const state = getAggregatorState();

  if (storeInBuffer) {
    ringBufferPush(state.eventBuffer, event);
  }

  if (event.ms !== undefined) {
    const key = event.phase ? `${event.op}.${event.phase}` : event.op;
    recordStats(key, event.ms);
  }

  if (event.gauges) {
    const baseKey = event.phase ? `${event.op}.${event.phase}` : event.op;
    for (const [gaugeName, value] of Object.entries(event.gauges)) {
      recordStats(`${baseKey}.${gaugeName}`, value);
    }
  }
}

export function getAggregates(): Record<string, AggregatedStats> {
  const state = getAggregatorState();
  const result: Record<string, AggregatedStats> = {};
  for (const [key, statsState] of state.stats) {
    result[key] = getStats(statsState);
  }
  return result;
}

/** Returns events in chronological order (oldest first). */
export function getRecentEvents(): ProfilingEvent[] {
  return ringBufferToArray(getAggregatorState().eventBuffer);
}

export function getEventCount(): number {
  const state = getAggregatorState();
  let total = 0;
  for (const statsState of state.stats.values()) {
    total += statsState.count;
  }
  return total;
}

export function getDroppedCount(): number {
  return ringBufferDroppedCount(getAggregatorState().eventBuffer);
}

export function clearAggregator(): void {
  const state = getAggregatorState();
  state.stats.clear();
  ringBufferClear(state.eventBuffer);
}

export function setMaxRecentEvents(max: number): void {
  const state = getAggregatorState();
  state.eventBuffer = ringBufferResize(state.eventBuffer, max);
}
