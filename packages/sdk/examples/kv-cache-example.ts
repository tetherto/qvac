import {
  completion,
  LLAMA_3_2_1B_INST_Q4_0,
  loadModel,
  unloadModel,
  VERBOSITY,
} from "@qvac/sdk";

try {
  // Load the model
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    modelConfig: {
      device: "gpu",
      ctx_size: 2048,
      verbosity: VERBOSITY.ERROR,
    },
  });

  console.log("🧠 Testing KV Cache functionality...\n");

  // First conversation with auto-keyed cache enabled
  console.log("📝 First conversation (building cache for the next turn):");
  const history1 = [
    { role: "user", content: "What is the capital of France?" },
  ];

  const result1 = completion({
    modelId,
    history: history1,
    stream: true,
    kvCache: true,
  }); // kvCache = true

  for await (const token of result1.tokenStream) {
    process.stdout.write(token);
  }

  const final1 = await result1.final;
  const stats1 = final1.stats;
  console.log(`\n⏱️  First completion stats: ${JSON.stringify(stats1)}\n`);

  // Continue conversation (should reuse the completed first-turn cache).
  console.log("🔄 Continuing conversation (reusing previous turn cache):");
  const history2 = [
    { role: "user", content: "What is the capital of France?" },
    { role: "assistant", content: final1.cacheableAssistantContent ?? final1.contentText },
    { role: "user", content: "What about Germany?" },
  ];

  // Auto-keyed caching should:
  // 1. Find the cache saved after turn 1 under [user, assistant]
  // 2. Load that cache and process only the new "What about Germany?" user turn
  // 3. Save the updated cache and rename it to include the new assistant response
  const result2 = completion({
    modelId,
    history: history2,
    stream: true,
    kvCache: true,
  }); // kvCache = true

  for await (const token of result2.tokenStream) {
    process.stdout.write(token);
  }

  const stats2 = await result2.stats;
  console.log(`\n⏱️  Second completion stats: ${JSON.stringify(stats2)}\n`);

  // Compare with non-cached version
  console.log("🚀 Same conversation without cache:");
  const result3 = completion({
    modelId,
    history: history2,
    stream: true,
    kvCache: false,
  }); // kvCache = false

  for await (const token of result3.tokenStream) {
    process.stdout.write(token);
  }

  const stats3 = await result3.stats;
  console.log(`\n⏱️  Non-cached completion stats: ${JSON.stringify(stats3)}\n`);

  console.log("✅ KV Cache test completed!");

  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
