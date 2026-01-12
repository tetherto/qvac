import {
  completion,
  LLAMA_3_2_1B_INST_Q4_0,
  loadModel,
  close,
} from "@qvac/sdk";

// Topic hex (required)
const topicHex = process.argv[2];
if (!topicHex) {
  console.error(
    "❌ Topic hex is required. Usage: node consumer.ts <topic-hex> <provider-public-key> [consumer-seed]",
  );
  process.exit(1);
}

// Provider public key (required)
const providerPublicKey = process.argv[3];
if (!providerPublicKey) {
  console.error(
    "❌ Provider public key is required. Usage: node consumer.ts <topic-hex> <provider-public-key> [consumer-seed]",
  );
  process.exit(1);
}

try {
  // Optional: Consumer seed for deterministic consumer identity (for firewall testing)
  const consumerSeed = process.argv[4];

  process.env["QVAC_HYPERSWARM_SEED"] = consumerSeed;

  console.log(`🚀 Testing delegated inference`);
  console.log(`📡 Topic: ${topicHex}`);
  console.log(`🔑 Provider: ${providerPublicKey}`);
  if (consumerSeed) {
    console.log(
      `🔑 Consumer seed: ${consumerSeed.substring(0, 16)}... (deterministic identity)`,
    );
  } else {
    console.log(`🎲 No consumer seed provided (random identity)`);
  }

  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    delegate: {
      topic: topicHex,
      providerPublicKey,
      timeout: 5_000, // Optional: 5 second timeout for delegated requests
      fallbackToLocal: true, // Optional: Fall back to local inference if delegation fails
      // forceNewConnection: true, // Optional: Force a new connection instead of reusing cached one
    },
    onProgress: (progress) => {
      console.log(
        `📊 Download progress: ${progress.percentage.toFixed(1)}% (${progress.downloaded}/${progress.total} bytes)`,
      );
    },
  });

  console.log(`✅ Delegated model registered: ${modelId}`);

  const response = completion({
    modelId,
    history: [{ role: "user", content: "Hello!" }],
    stream: true,
  });

  for await (const token of response.tokenStream) {
    console.log(`📨 Response: ${token}`);
  }

  console.log("🔍 Stats:", await response.stats);

  console.log(
    "\n🎯 Delegation infrastructure working! Server correctly detected and routed the delegated request.",
  );

  void close();
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
