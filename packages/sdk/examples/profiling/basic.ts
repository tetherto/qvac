import {
  completion,
  loadModel,
  unloadModel,
  LLAMA_3_2_1B_INST_Q4_0,
  profiler,
} from "@qvac/sdk";

try {
  // Enable profiling globally
  profiler.enable({
    mode: "verbose",
    includeServerBreakdown: true,
  });
  console.log("Profiler enabled:", profiler.isEnabled());

  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    onProgress: (p) => console.log(`  ${p.percentage.toFixed(1)}%`),
  });
  console.log("Model loaded:", modelId);

  console.log("\n→ Running completion...");
  const result = completion({
    modelId,
    history: [{ role: "user", content: "Say hello in one sentence." }],
    stream: true,
  });

  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }
  console.log();

  await unloadModel({ modelId });

  // Export profiling data
  console.log("\n=== Profiler Summary ===");
  console.log(profiler.exportSummary());

  console.log("\n=== Profiler Table ===");
  console.log(profiler.exportTable());

  const json = profiler.exportJSON();
  console.log("\n=== Load Model Metrics ===");
  // Filter for operation-level event (kind: "handler"), not RPC phase events
  const loadModelEvent = json.recentEvents?.find(
    (e) => e.op === "loadModel" && e.kind === "handler",
  );
  if (loadModelEvent) {
    const tags = loadModelEvent.tags ?? {};
    const gauges = loadModelEvent.gauges ?? {};
    console.log("  sourceType:", tags["sourceType"] ?? "(not set)");
    console.log("  cacheHit:", tags["cacheHit"] ?? "(not set)");
    console.log("  totalLoadTime:", gauges["totalLoadTime"], "ms");
    console.log(
      "  modelInitializationTime:",
      gauges["modelInitializationTime"],
      "ms",
    );
    if (tags["cacheHit"] !== "true") {
      console.log("  downloadTime:", gauges["downloadTime"] ?? "(cached)", "ms");
      console.log(
        "  totalBytesDownloaded:",
        gauges["totalBytesDownloaded"] ?? "(cached)",
      );
      console.log(
        "  downloadSpeedBps:",
        gauges["downloadSpeedBps"] ?? "(cached)",
      );
    } else {
      console.log("  (download metrics omitted - cache hit)");
    }
    if (gauges["checksumValidationTime"] !== undefined) {
      console.log("  checksumValidationTime:", gauges["checksumValidationTime"], "ms");
    }
  } else {
    console.log("  (no loadModel handler event captured)");
    // Debug: show what ops are available
    const ops = [...new Set(json.recentEvents?.map((e) => `${e.op}:${e.kind}`) ?? [])];
    console.log("  Available ops:", ops.join(", "));
  }

  console.log("\n=== Profiler JSON (structure) ===");
  console.log("  aggregates:", Object.keys(json.aggregates).length, "metrics");
  console.log("  recentEvents:", json.recentEvents?.length ?? 0, "events");
  console.log("  config:", json.config);

  // Disable profiling
  profiler.disable();
  console.log("\nProfiler disabled:", !profiler.isEnabled());
} catch (error) {
  console.error("Error:", error);
  process.exit(1);
}
