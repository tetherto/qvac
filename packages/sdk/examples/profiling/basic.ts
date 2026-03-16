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
