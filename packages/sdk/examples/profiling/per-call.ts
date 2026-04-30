import {
  embed,
  loadModel,
  unloadModel,
  GTE_LARGE_FP16,
  profiler,
} from "@qvac/sdk";

try {
  profiler.disable();
  console.log("Profiler globally enabled:", profiler.isEnabled());

  const modelId = await loadModel({
    modelSrc: GTE_LARGE_FP16,
    modelType: "embeddings",
    onProgress: (p) => console.log(`  ${p.percentage.toFixed(1)}%`),
  });
  console.log("Model loaded:", modelId);

  console.log("\n=== Embed with per-call profiling ===");
  const { embedding: embedding1 } = await embed(
    { modelId, text: "Profile this specific call" },
    { profiling: { enabled: true, includeServerBreakdown: true } },
  );
  console.log("Embedding dimensions:", embedding1.length);

  console.log("\n=== Embed without profiling ===");
  const { embedding: embedding2 } = await embed({
    modelId,
    text: "This call is not profiled",
  });
  console.log("Embedding dimensions:", embedding2.length);

  console.log("\n=== Embed with profiling explicitly disabled ===");
  const { embedding: embedding3 } = await embed(
    { modelId, text: "Profiling explicitly disabled for this call" },
    { profiling: { enabled: false } },
  );
  console.log("Embedding dimensions:", embedding3.length);

  await unloadModel({ modelId });

  console.log("\n=== Profiler Summary (per-call data only) ===");
  console.log(profiler.exportSummary());
} catch (error) {
  console.error("Error:", error);
  process.exit(1);
}
