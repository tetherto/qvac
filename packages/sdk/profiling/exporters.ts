/**
 * JSON, table, and summary export utilities for profiling data.
 */

import type { ProfilerExport, AggregatedStats } from "./types";
import {
  getEffectiveConfig,
  getAggregates,
  getRecentEvents,
} from "./controller";
import { getDroppedCount, getEventCount } from "./aggregator";
import { nowMs, getClockSource, isMonotonic } from "./clock";

export function exportJSON(options?: {
  includeRecentEvents?: boolean;
}): ProfilerExport {
  const config = getEffectiveConfig();
  const includeRecent = options?.includeRecentEvents ?? true;

  const result: ProfilerExport = {
    config,
    aggregates: getAggregates(),
    exportedAt: nowMs(),
  };

  if (includeRecent && config.mode === "verbose") {
    result.recentEvents = getRecentEvents();
  }

  return result;
}

function aggregateMatchingStats(
  aggregates: Record<string, AggregatedStats>,
  predicate: (key: string) => boolean,
): AggregatedStats | undefined {
  const matches = Object.entries(aggregates).filter(([key]) => predicate(key));
  if (matches.length === 0) {
    return undefined;
  }

  let count = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let last = 0;

  for (const [, stats] of matches) {
    count += stats.count;
    sum += stats.sum;
    if (stats.count > 0) {
      if (stats.min < min) min = stats.min;
      if (stats.max > max) max = stats.max;
      last = stats.last;
    }
  }

  return {
    count,
    min: count > 0 ? min : 0,
    max: count > 0 ? max : 0,
    avg: count > 0 ? sum / count : 0,
    sum,
    last,
  };
}

function formatDuration(ms: number): string {
  if (ms < 1) {
    return `${(ms * 1000).toFixed(0)}μs`;
  }
  if (ms < 1000) {
    return `${ms.toFixed(1)}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  return `${(ms / 60000).toFixed(2)}m`;
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) {
    return n.toLocaleString();
  }
  if (n === 0) return "0";
  if (Math.abs(n) < 0.01) return n.toExponential(2);
  if (Math.abs(n) < 1) return n.toFixed(3);
  if (Math.abs(n) < 100) return n.toFixed(2);
  return n.toFixed(1);
}

function pad(s: string, len: number, align: "left" | "right" = "left"): string {
  if (s.length >= len) return s.substring(0, len);
  const spaces = " ".repeat(len - s.length);
  return align === "left" ? s + spaces : spaces + s;
}

export function exportTable(): string {
  const aggregates = getAggregates();
  const entries = Object.entries(aggregates);

  if (entries.length === 0) {
    return "No profiling data recorded.";
  }

  const metricWidth = 40;
  const numWidth = 12;

  const header = [
    pad("Metric", metricWidth),
    pad("Count", numWidth, "right"),
    pad("Min", numWidth, "right"),
    pad("Max", numWidth, "right"),
    pad("Avg", numWidth, "right"),
    pad("Total", numWidth, "right"),
  ].join(" | ");

  const separator = "-".repeat(header.length);

  const rows = entries
    .sort((a, b) => b[1].sum - a[1].sum)
    .map(([metric, stats]) => {
      return [
        pad(metric, metricWidth),
        pad(formatNumber(stats.count), numWidth, "right"),
        pad(formatDuration(stats.min), numWidth, "right"),
        pad(formatDuration(stats.max), numWidth, "right"),
        pad(formatDuration(stats.avg), numWidth, "right"),
        pad(formatDuration(stats.sum), numWidth, "right"),
      ].join(" | ");
    });

  return [separator, header, separator, ...rows, separator].join("\n");
}

export function exportSummary(): string {
  const aggregates = getAggregates();
  const config = getEffectiveConfig();
  const eventCount = getEventCount();
  const droppedCount = getDroppedCount();

  const lines: string[] = [
    "=".repeat(60),
    "PROFILER SUMMARY",
    "=".repeat(60),
    "",
    "Session:",
    `  Status:        ${config.enabled ? "enabled" : "disabled"}`,
    `  Mode:          ${config.mode}`,
    `  Clock:         ${getClockSource()} (monotonic: ${isMonotonic()})`,
    `  Events:        ${eventCount.toLocaleString()}`,
    `  Dropped:       ${droppedCount.toLocaleString()}`,
    "",
  ];

  const keyMetrics = [
    {
      label: "RPC Total",
      stats: aggregateMatchingStats(aggregates, (key) =>
        key.endsWith(".totalClientTime"),
      ),
    },
    {
      label: "Handler",
      stats: aggregateMatchingStats(
        aggregates,
        (key) => key.endsWith(".server.handlerExecution") || !key.includes("."),
      ),
    },
    {
      label: "Model Load",
      stats: aggregateMatchingStats(
        aggregates,
        (key) => key === "load.totalTime" || key.endsWith(".load.totalTime"),
      ),
    },
    {
      label: "Download",
      stats: aggregateMatchingStats(
        aggregates,
        (key) => key === "download.time" || key.endsWith(".download.time"),
      ),
    },
  ];

  const hasMetrics = keyMetrics.some((m) => m.stats);

  if (hasMetrics) {
    lines.push("Key Metrics:");
    lines.push("-".repeat(60));
    lines.push(
      "  " +
        "Metric".padEnd(18) +
        "Samples".padStart(10) +
        "Avg".padStart(12) +
        "Total".padStart(12),
    );
    lines.push("-".repeat(60));

    for (const { label, stats } of keyMetrics) {
      if (stats) {
        const name = label.padEnd(18);
        const samples = String(stats.count).padStart(10);
        const avg = formatDuration(stats.avg).padStart(12);
        const total = formatDuration(stats.sum).padStart(12);
        lines.push(`  ${name}${samples}${avg}${total}`);
      }
    }
  } else {
    lines.push("No metrics recorded yet.");
  }

  lines.push("");
  lines.push("=".repeat(60));

  return lines.join("\n");
}
