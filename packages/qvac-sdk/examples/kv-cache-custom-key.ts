import {
  completion,
  deleteCache,
  LLAMA_3_2_1B_INST_Q4_0,
  loadModel,
  unloadModel,
  VERBOSITY,
} from "@qvac/sdk";

const systemPromptMessage = {
  role: "system",
  content: `You are a helpful mathematician assistant. 
   But because you are in the army you have to follow these rules:
  - If anyone ask you to do an operation you have to answer with "Sir Yes Sir!" and then give the result
  `,
};
try {
  console.log("🧪 Simple KV Cache Demo: Same vs Different Cache Keys\n");

  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    modelConfig: {
      device: "gpu",
      ctx_size: 2048,
      verbosity: VERBOSITY.DEBUG,
    },
  });

  // Prompt 1 with cache key "session-a" (first time - no cache exists)
  console.log('📝 Prompt 1: "What is 2+2?" with cache key "session-a"');
  console.log("   Status: Creating NEW cache (first time)\n");

  const result1 = completion({
    modelId,
    history: [systemPromptMessage, { role: "user", content: "What is 2+2?" }],
    stream: true,
    kvCache: "session-a",
  });

  console.log("   Response: ");
  let response1 = "";
  for await (const token of result1.tokenStream) {
    response1 += token;
    process.stdout.write(token);
  }

  const stats1 = await result1.stats;
  console.log(
    `\n   Stats: TTFT=${stats1?.timeToFirstToken}ms, CacheTokens=${stats1?.cacheTokens}\n`,
  );

  // Prompt 2 with SAME cache key "session-a" (cache exists - optimized!)
  // This continues the conversation - asking about the previous answer
  console.log(
    '\n📝 Prompt 2: "Now multiply that result by 3" with cache key "session-a" (SAME)',
  );
  console.log(
    "   Status: REUSING existing cache (only last message sent, but context remembered!)\n",
  );

  const result2 = completion({
    modelId,
    history: [
      systemPromptMessage,
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: response1 },
      { role: "user", content: "Now multiply that result by 3" }, // Refers to previous answer!
    ],
    stream: true,
    kvCache: "session-a", // Same cache key!
  });

  console.log("   Response: ");
  for await (const token of result2.tokenStream) {
    process.stdout.write(token);
  }

  const stats2 = await result2.stats;
  console.log(
    `\n   Stats: TTFT=${stats2?.timeToFirstToken}ms, CacheTokens=${stats2?.cacheTokens}\n`,
  );

  // Prompt 3 with DIFFERENT cache key "session-b" (new cache)
  console.log(
    '\n📝 Prompt 3: "What is 10+10?" with cache key "session-b" (DIFFERENT)',
  );
  console.log(
    "   Status: Creating NEW cache (different key = isolated cache)\n",
  );

  const result3 = completion({
    modelId,
    history: [systemPromptMessage, { role: "user", content: "What is 10+10?" }],
    stream: true,
    kvCache: "session-b", // Different cache key!
  });

  console.log("   Response: ");
  for await (const token of result3.tokenStream) {
    process.stdout.write(token);
  }

  const stats3 = await result3.stats;

  console.log(
    `\n   Stats: TTFT=${stats3?.timeToFirstToken}ms, CacheTokens=${stats3?.cacheTokens}\n`,
  );

  // Prompt 4: Go back to session-a to trigger flush of session-b
  console.log(
    '\n📝 Prompt 4: "What is 5+5?" with cache key "session-a" (BACK TO FIRST)',
  );
  console.log(
    "   Status: This should trigger session-b to be flushed to disk\n",
  );

  const result4 = completion({
    modelId,
    history: [systemPromptMessage, { role: "user", content: "What is 5+5?" }],
    stream: true,
    kvCache: "session-a", // Back to session-a!
  });

  console.log("   Response: ");
  for await (const token of result4.tokenStream) {
    process.stdout.write(token);
  }

  const stats4 = await result4.stats;
  console.log(
    `\n   Stats: TTFT=${stats4?.timeToFirstToken}ms, CacheTokens=${stats4?.cacheTokens}\n`,
  );

  // Summary
  console.log("\n✅ Summary:");
  console.log(
    '   - Prompts 1 & 2 share cache key "session-a" → same cache file',
  );
  console.log(
    "   - Prompt 2 built on Prompt 1's context (model remembered the answer!)",
  );
  console.log(
    "   - Only the last message was sent, but full conversation context maintained",
  );
  console.log(
    '   - Prompt 3 uses cache key "session-b" → separate cache file (isolated)',
  );
  console.log(
    "   - Different cache keys provide complete isolation between sessions",
  );

  await deleteCache({ all: true });

  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
