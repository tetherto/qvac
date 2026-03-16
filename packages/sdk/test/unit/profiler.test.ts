import test from "brittle";
import {
  enable,
  disable,
  isEnabled,
  shouldProfile,
  shouldIncludeServerBreakdown,
  record,
  getAggregates,
  getRecentEvents,
} from "../../profiling/controller";
import { clearAggregator } from "../../profiling/aggregator";
import {
  exportJSON,
  exportTable,
  exportSummary,
} from "../../profiling/exporters";
import type { ProfilingEvent } from "../../profiling/types";

function reset() {
  disable();
  clearAggregator();
}

function testEvent(op: string, phase: string, ms: number): ProfilingEvent {
  return { ts: Date.now(), op, kind: "rpc", phase, ms };
}

// =============================================================================
// Core Contract
// =============================================================================

test("profiler: enable/disable toggles isEnabled", (t: any) => {
  reset();
  t.is(isEnabled(), false, "disabled by default");

  enable();
  t.is(isEnabled(), true, "enabled after enable()");

  disable();
  t.is(isEnabled(), false, "disabled after disable()");
});

test("profiler: enable() resets aggregates and events", (t: any) => {
  reset();
  enable({ mode: "verbose" });
  record(testEvent("test", "a", 100));
  record(testEvent("test", "b", 200));

  const before = getAggregates();
  t.ok(Object.keys(before).length > 0, "has aggregates before re-enable");

  enable({ mode: "verbose" });

  const after = getAggregates();
  t.is(Object.keys(after).length, 0, "aggregates cleared after enable()");

  const events = getRecentEvents();
  t.is(events.length, 0, "events cleared after enable()");
});

test("profiler: disable() preserves aggregates but exportJSON omits events", (t: any) => {
  reset();
  enable({ mode: "verbose" });
  record(testEvent("test", "x", 50));
  disable();

  const aggregates = getAggregates();
  t.ok(
    Object.keys(aggregates).length > 0,
    "aggregates preserved after disable",
  );

  const json = exportJSON();
  t.ok(
    Object.keys(json.aggregates).length > 0,
    "exportJSON includes aggregates",
  );
  t.is(
    json.recentEvents,
    undefined,
    "exportJSON omits recentEvents after disable",
  );
});

test("profiler: verbose mode buffers events", (t: any) => {
  reset();
  enable({ mode: "verbose" });
  record(testEvent("test", "v", 10));

  const events = getRecentEvents();
  t.ok(events.length > 0, "events buffered in verbose mode");
});

test("profiler: summary mode does not buffer events", (t: any) => {
  reset();
  enable({ mode: "summary" });
  record(testEvent("test", "s", 10));

  const events = getRecentEvents();
  t.is(events.length, 0, "no events buffered in summary mode");

  const aggregates = getAggregates();
  t.ok(Object.keys(aggregates).length > 0, "aggregates still recorded");
});

test("profiler: exportJSON omits recentEvents in summary mode", (t: any) => {
  reset();
  enable({ mode: "summary" });
  record(testEvent("test", "e", 10));

  const json = exportJSON();
  t.is(json.recentEvents, undefined, "recentEvents omitted in summary");
  t.ok(Object.keys(json.aggregates).length > 0, "aggregates present");
});

test("profiler: exportJSON includes recentEvents in verbose mode", (t: any) => {
  reset();
  enable({ mode: "verbose" });
  record(testEvent("test", "e", 10));

  const json = exportJSON();
  t.ok(Array.isArray(json.recentEvents), "recentEvents included in verbose");
  t.ok(json.recentEvents!.length > 0, "recentEvents has entries");
});

test("profiler: exportTable returns string", (t: any) => {
  reset();
  enable();
  record(testEvent("test", "t", 10));

  const table = exportTable();
  t.is(typeof table, "string");
  t.ok(table.includes("test.t"), "table contains metric key");
});

test("profiler: exportSummary returns string", (t: any) => {
  reset();
  enable();
  record(testEvent("test", "s", 10));

  const summary = exportSummary();
  t.is(typeof summary, "string");
  t.ok(summary.includes("PROFILER SUMMARY"), "summary has header");
});

// =============================================================================
// Precedence
// =============================================================================

test("profiler: shouldProfile per-call > runtime > default", (t: any) => {
  reset();

  // Default: disabled
  t.is(shouldProfile("test"), false, "disabled by default");

  // Runtime enable
  enable();
  t.is(shouldProfile("test"), true, "runtime enable takes effect");

  // Per-call disable overrides runtime
  t.is(
    shouldProfile("test", { enabled: false }),
    false,
    "per-call disable wins",
  );

  // Per-call enable when runtime disabled
  disable();
  t.is(shouldProfile("test", { enabled: true }), true, "per-call enable wins");
});

test("profiler: shouldIncludeServerBreakdown per-call > runtime > default", (t: any) => {
  reset();

  // Default: false
  t.is(shouldIncludeServerBreakdown(), false, "default false");

  // Runtime enable with includeServerBreakdown
  enable({ includeServerBreakdown: true });
  t.is(
    shouldIncludeServerBreakdown(),
    true,
    "runtime includeServer takes effect",
  );

  // Per-call override
  t.is(
    shouldIncludeServerBreakdown({ includeServerBreakdown: false }),
    false,
    "per-call override wins",
  );

  // Per-call enable when runtime disabled
  disable();
  enable({ includeServerBreakdown: false });
  t.is(
    shouldIncludeServerBreakdown({ includeServerBreakdown: true }),
    true,
    "per-call enable wins",
  );
});

// =============================================================================
// Gating (wrapper-level disabled path)
// =============================================================================

test("profiler: no aggregates when globally disabled and no per-call override", (t: any) => {
  reset();
  // Simulate what wrappers do: check shouldProfile before recording
  if (shouldProfile("gated")) {
    record(testEvent("gated", "test", 100));
  }

  const aggregates = getAggregates();
  t.is(Object.keys(aggregates).length, 0, "nothing recorded when gated");
});

test("profiler: per-call enabled:true records even when globally disabled", (t: any) => {
  reset();
  if (shouldProfile("percall", { enabled: true })) {
    record(testEvent("percall", "enabled", 50));
  }

  const aggregates = getAggregates();
  t.ok(
    "percall.enabled" in aggregates,
    "per-call enable bypasses global disable",
  );
});

test("profiler: per-call enabled:false suppresses when globally enabled", (t: any) => {
  reset();
  enable();
  if (shouldProfile("suppressed", { enabled: false })) {
    record(testEvent("suppressed", "test", 50));
  }

  const aggregates = getAggregates();
  t.not(
    "suppressed.test" in aggregates,
    "per-call disable suppresses recording",
  );
});
