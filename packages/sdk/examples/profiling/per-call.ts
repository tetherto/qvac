import {
  embed,
  loadModel,
  unloadModel,
  GTE_LARGE_FP16,
  profiler,
} from "@qvac/sdk";

try {
  profiler.disable();
  console.log("▸ Profiler globally enabled:", profiler.isEnabled());

  const modelId = await loadModel({
    modelSrc: GTE_LARGE_FP16,
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });
  console.log("▸ Model loaded:", modelId);

  console.log("\n▸ Embed with per-call profiling");
  const { embedding: embedding1 } = await embed(
    { modelId, text: "Profile this specific call" },
    { profiling: { enabled: true, includeServerBreakdown: true } },
  );
  console.log("▸ Embedding dimensions:", embedding1.length);

  console.log("\n▸ Embed without profiling");
  const { embedding: embedding2 } = await embed({
    modelId,
    text: "This call is not profiled",
  });
  console.log("▸ Embedding dimensions:", embedding2.length);

  console.log("\n▸ Embed with profiling explicitly disabled");
  const { embedding: embedding3 } = await embed(
    { modelId, text: "Profiling explicitly disabled for this call" },
    { profiling: { enabled: false } },
  );
  console.log("▸ Embedding dimensions:", embedding3.length);

  await unloadModel({ modelId });

  console.log("\n▸ Profiler Summary (per-call data only)");
  console.log(profiler.exportSummary());
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
