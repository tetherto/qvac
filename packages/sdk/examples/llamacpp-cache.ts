import {
  completion,
  deleteCache,
  LLAMA_3_2_1B_INST_Q4_0,
  loadModel,
  type CompletionStats,
  unloadModel,
  VERBOSITY,
} from "@qvac/sdk";

type ChatMessage = {
  role: string;
  content: string;
};

const sharedCacheKey = "llamacpp-cache-demo-shared";
const isolatedCacheKey = "llamacpp-cache-demo-isolated";

const systemPrompt = {
  role: "system",
  content:
    "You are a concise travel assistant. Keep track of the user's preferences across turns.",
};

function printStats(stats: CompletionStats | undefined) {
  console.log("\nPerformance Stats:", {
    timeToFirstToken: stats?.timeToFirstToken,
    tokensPerSecond: stats?.tokensPerSecond,
    cacheTokens: stats?.cacheTokens,
  });
}

async function runCachedCompletion(params: {
  label: string;
  modelId: string;
  history: ChatMessage[];
  kvCache?: string | boolean;
}) {
  console.log(`\n=== ${params.label} ===`);
  console.log(`Cache key: ${params.kvCache || "disabled"}`);
  console.log("AI Response:");

  const result = completion({
    modelId: params.modelId,
    history: params.history,
    stream: true,
    kvCache: params.kvCache,
  });

  let text = "";
  for await (const token of result.tokenStream) {
    text += token;
    process.stdout.write(token);
  }

  const stats = await result.stats;
  printStats(stats);

  return { text, stats };
}

let modelId: string | undefined;

try {
  console.log("Loading llama.cpp model with cache support...");

  modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    modelConfig: {
      ctx_size: 4096,
      verbosity: VERBOSITY.ERROR,
    },
    onProgress: (progress) => {
      console.log(`Loading: ${progress.percentage.toFixed(1)}%`);
    },
  });

  console.log(`Model loaded successfully. Model ID: ${modelId}`);

  await deleteCache({ kvCacheKey: sharedCacheKey });
  await deleteCache({ kvCacheKey: isolatedCacheKey });

  const firstUserMessage = {
    role: "user",
    content:
      "I am planning a weekend in Lisbon. I prefer museums, seafood, and walking routes. Suggest a day plan in 3 bullets.",
  };

  const firstTurn = await runCachedCompletion({
    label: "Turn 1: create a named cache",
    modelId,
    kvCache: sharedCacheKey,
    history: [systemPrompt, firstUserMessage],
  });

  await runCachedCompletion({
    label: "Turn 2: reuse the same cache key",
    modelId,
    kvCache: sharedCacheKey,
    history: [
      systemPrompt,
      firstUserMessage,
      { role: "assistant", content: firstTurn.text.trim() },
      {
        role: "user",
        content:
          "Now revise the plan for a rainy day, but keep the same preferences.",
      },
    ],
  });

  await runCachedCompletion({
    label: "Turn 3: use a different cache key for an isolated session",
    modelId,
    kvCache: isolatedCacheKey,
    history: [
      systemPrompt,
      {
        role: "user",
        content:
          "I am planning a weekend in Berlin. I prefer nightlife and late starts. Suggest a day plan in 3 bullets.",
      },
    ],
  });

  console.log("\nSummary:");
  console.log(`- Reusing "${sharedCacheKey}" keeps conversation context across turns.`);
  console.log(`- Switching to "${isolatedCacheKey}" starts a separate cache session.`);
  console.log(
    '- Use deleteCache({ kvCacheKey: "your-session" }) to clear a saved session.',
  );

  await deleteCache({ kvCacheKey: sharedCacheKey });
  await deleteCache({ kvCacheKey: isolatedCacheKey });
  await unloadModel({ modelId, clearStorage: false });

  process.exit(0);
} catch (error) {
  if (modelId) {
    try {
      await unloadModel({ modelId, clearStorage: false });
    } catch (cleanupError) {
      console.warn("⚠️ cleanup failed:", cleanupError);
    }
  }

  console.error("❌ Error:", error);
  process.exit(1);
}
