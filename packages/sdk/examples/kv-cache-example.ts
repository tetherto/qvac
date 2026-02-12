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

  // First conversation with cache enabled
  console.log("📝 First conversation (building cache):");
  const history1 = [
    { role: "user", content: "What is the capital of France?" },
  ];

  const result1 = completion({
    modelId,
    history: history1,
    stream: true,
    kvCache: true,
  }); // kvCache = true

  let response1 = "";
  for await (const token of result1.tokenStream) {
    response1 += token;
    process.stdout.write(token);
  }

  const stats1 = await result1.stats;
  console.log(`\n⏱️  First completion stats: ${JSON.stringify(stats1)}\n`);

  // Continue conversation (should reuse cache from previous conversation)
  console.log("🔄 Continuing conversation (reusing cache):");
  const history2 = [
    { role: "user", content: "What is the capital of France?" },
    { role: "assistant", content: response1.trim() },
    { role: "user", content: "What about Germany?" },
  ];

  // This should:
  // 1. Find existing cache from [user: "What is the capital of France?"] (history minus last message)
  // 2. Load that cache and process the new "What about Germany?" message
  // 3. Save the updated cache and rename it to include all messages
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
