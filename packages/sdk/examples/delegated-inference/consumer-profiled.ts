import {
  close,
  completion,
  LLAMA_3_2_1B_INST_Q4_0,
  loadModel,
  profiler,
} from "@qvac/sdk";

const topicHex = process.argv[2];
if (!topicHex) {
  console.error("❌ Usage: bun run consumer-profiled.ts <topic> <publicKey>");
  process.exit(1);
}

const providerPublicKey = process.argv[3];
if (!providerPublicKey) {
  console.error("❌ Usage: bun run consumer-profiled.ts <topic> <publicKey>");
  process.exit(1);
}

try {
  profiler.enable({ mode: "verbose", includeServerBreakdown: true });
  console.log("✓ Profiler enabled");

  console.log(`\n📡 Topic: ${topicHex}`);
  console.log(`🔑 Provider: ${providerPublicKey}\n`);

  console.log("→ Loading model (delegated, unary)...");
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    delegate: {
      topic: topicHex,
      providerPublicKey,
      timeout: 30_000,
    },
  });
  console.log(`✓ Model loaded: ${modelId}\n`);

  console.log("→ Running completion (delegated, streamed)...");
  const response = completion({
    modelId,
    history: [{ role: "user", content: "Say hello in exactly 5 words." }],
    stream: true,
  });

  process.stdout.write("  Response: ");
  for await (const token of response.tokenStream) {
    process.stdout.write(token);
  }
  await response.stats;
  console.log("\n✓ Completion done\n");

  console.log("=== Profiler Summary ===");
  console.log(profiler.exportSummary());

  console.log("=== Profiler Table ===");
  console.log(profiler.exportTable());

  // Look for delegation-specific metrics
  const json = profiler.exportJSON();
  const delegationMetrics = Object.keys(json.aggregates).filter(
    (k) => k.includes("delegation") || k.includes("delegated"),
  );

  if (delegationMetrics.length > 0) {
    console.log("=== Delegation Metrics ===");
    for (const key of delegationMetrics) {
      const agg = json.aggregates[key];
      if (agg) {
        console.log(`  ${key}: ${agg.avg.toFixed(2)}ms (count: ${agg.count})`);
      }
    }
  } else {
    console.log("⚠️  No delegation-specific metrics found");
    console.log("    (delegation profiling may need to be triggered)");
  }

  profiler.disable();
  void close();
} catch (error) {
  console.error("❌ Error:", error);
  profiler.disable();
  process.exit(1);
}
