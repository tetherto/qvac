import test from "brittle";
import { sourceTypeSchema, type OperationEvent } from "@/schemas";
import { buildOperationEvent } from "@/server/rpc/profiling";
import type { ProfilingEvent } from "@/profiling/types";
import { injectProfilingIntoString } from "@/server/rpc/profiling/context";
import { extractProfilingMeta } from "@/profiling";
import { clearAggregator, getAggregates, recordEvent } from "@/profiling/aggregator";

test("sourceType: accepts expected values and rejects unknown", (t) => {
  const expected = ["hyperdrive", "http", "registry", "filesystem"];
  for (const value of expected) {
    t.ok(sourceTypeSchema.safeParse(value).success, `${value} is valid`);
  }

  t.absent(sourceTypeSchema.safeParse("unknown").success, "unknown is invalid");
});

test("operation metrics: loadModel extracts gauges and tags", (t) => {
  const event = buildOperationEvent(
    "loadModel",
    "profile-1",
    100,
    500,
    { modelType: "llamacpp-completion" },
    {
      __profilingMeta: {
        sourceType: "registry",
        downloadStats: {
          downloadTimeMs: 220,
          totalBytesDownloaded: 4096,
          downloadSpeedBps: 18618,
        },
        modelInitializationTimeMs: 130,
        totalLoadTimeMs: 500,
      },
    },
  );

  t.ok(event, "event is built");
  t.alike(event!.tags, { modelType: "llamacpp-completion", sourceType: "registry" });
  t.is(event!.gauges?.downloadTime, 220);
  t.is(event!.gauges?.totalBytesDownloaded, 4096);
  t.is(event!.gauges?.downloadSpeedBps, 18618);
  t.is(event!.gauges?.modelInitializationTime, 130);
  t.is(event!.gauges?.totalLoadTime, 500);
});

test("operation metrics: omits unavailable gauges (no fabrication)", (t) => {
  const event = buildOperationEvent(
    "loadModel",
    "profile-2",
    100,
    90,
    { modelType: "llamacpp-completion" },
    {
      __profilingMeta: {
        sourceType: "filesystem",
        totalLoadTimeMs: 90,
      },
    },
  );

  t.ok(event, "event is built");
  const gauges = event!.gauges ?? {};
  t.is(gauges.totalLoadTime, 90, "keeps provided metric");
  t.is("downloadTime" in gauges, false, "does not fabricate downloadTime");
  t.is(
    "totalBytesDownloaded" in gauges,
    false,
    "does not fabricate totalBytesDownloaded",
  );
  t.is(
    "modelInitializationTime" in gauges,
    false,
    "does not fabricate modelInitializationTime",
  );
});

test("transport: operation event survives injection/extraction round-trip", (t) => {
  const operation: OperationEvent = {
    op: "loadModel",
    kind: "handler",
    ms: 500,
    profileId: "round-trip-test",
    gauges: { totalLoadTime: 500, downloadTime: 200 },
    tags: { modelType: "llamacpp-completion", sourceType: "registry", cacheHit: "true" },
  };

  const baseJson = '{"type":"loadModel","success":true}';
  const injected = injectProfilingIntoString(baseJson, { operation });
  const parsed = JSON.parse(injected);
  const extracted = extractProfilingMeta(parsed);

  t.ok(extracted, "meta extracted");
  t.ok(extracted!.operation, "operation present");
  t.is(extracted!.operation!.op, "loadModel");
  t.is(extracted!.operation!.kind, "handler");
  t.is(extracted!.operation!.ms, 500);
  t.is(extracted!.operation!.profileId, "round-trip-test");
  t.alike(extracted!.operation!.gauges, { totalLoadTime: 500, downloadTime: 200 });
  t.alike(extracted!.operation!.tags, {
    modelType: "llamacpp-completion",
    sourceType: "registry",
    cacheHit: "true",
  });
});

test("cacheHit: cache-hit path omits download metrics", (t) => {
  clearAggregator();

  const cacheHitEvent: OperationEvent = {
    op: "loadModel",
    kind: "handler",
    ms: 500,
    gauges: {
      totalLoadTime: 500,
      modelInitializationTime: 400,
    },
    tags: { sourceType: "registry", cacheHit: "true" },
  };

  recordEvent({ ...cacheHitEvent, ts: Date.now() } as ProfilingEvent);

  const aggregates = getAggregates();
  t.ok(aggregates["loadModel.totalLoadTime"], "totalLoadTime aggregated");
  t.ok(
    aggregates["loadModel.modelInitializationTime"],
    "modelInitializationTime aggregated",
  );
  t.absent(
    aggregates["loadModel.downloadSpeedBps"],
    "downloadSpeedBps omitted on cache hit",
  );
  t.absent(aggregates["loadModel.downloadTime"], "downloadTime omitted on cache hit");
  t.absent(
    aggregates["loadModel.totalBytesDownloaded"],
    "totalBytesDownloaded omitted on cache hit",
  );

  clearAggregator();
});

test("cacheHit: cache-miss path includes download metrics", (t) => {
  clearAggregator();

  const cacheMissEvent: OperationEvent = {
    op: "loadModel",
    kind: "handler",
    ms: 2000,
    gauges: {
      totalLoadTime: 2000,
      modelInitializationTime: 400,
      downloadTime: 1500,
      totalBytesDownloaded: 1000000,
      downloadSpeedBps: 666666,
    },
    tags: { sourceType: "registry", cacheHit: "false" },
  };

  recordEvent({ ...cacheMissEvent, ts: Date.now() } as ProfilingEvent);

  const aggregates = getAggregates();
  t.ok(aggregates["loadModel.totalLoadTime"], "totalLoadTime aggregated");
  t.ok(
    aggregates["loadModel.modelInitializationTime"],
    "modelInitializationTime aggregated",
  );
  t.ok(aggregates["loadModel.downloadTime"], "downloadTime aggregated");
  t.ok(aggregates["loadModel.totalBytesDownloaded"], "totalBytesDownloaded aggregated");
  t.ok(aggregates["loadModel.downloadSpeedBps"], "downloadSpeedBps aggregated");

  clearAggregator();
});
