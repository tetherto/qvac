import {
  completion,
  loadModel,
  unloadModel,
  VERBOSITY,
  LLAMA_3_2_1B_INST_Q4_0_SHARD,
} from "@qvac/sdk";

try {
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0_SHARD,
    modelType: "llm",
    modelConfig: {
      device: "gpu",
      ctx_size: 2048,
      verbosity: VERBOSITY.ERROR,
    },
    onProgress: (progress) => {
      if (progress.shardInfo) {
        const { shardInfo } = progress;

        console.log(
          `📥 Downloading ${shardInfo.shardName} (${shardInfo.currentShard}/${shardInfo.totalShards})\n` +
            `   File: ${progress.percentage.toFixed(1)}% (${(progress.downloaded / 1024 / 1024).toFixed(2)}MB / ${(progress.total / 1024 / 1024).toFixed(2)}MB)\n` +
            `   Overall: ${shardInfo.overallPercentage.toFixed(1)}% (${(shardInfo.overallDownloaded / 1024 / 1024).toFixed(2)}MB / ${(shardInfo.overallTotal / 1024 / 1024).toFixed(2)}MB)`,
        );
      } else {
        // Fallback for non-sharded models
        console.log(
          `📥 Progress: ${progress.percentage.toFixed(1)}% ` +
            `(${(progress.downloaded / 1024 / 1024).toFixed(2)}MB / ${(progress.total / 1024 / 1024).toFixed(2)}MB)`,
        );
      }
    },
  });

  const history = [
    {
      role: "user",
      content:
        "What are the benefits of sharding large language models? Use emojis in your response.",
    },
  ];

  const result = completion({ modelId, history, stream: true });

  console.log("\n🤖 Model response:");
  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }

  const stats = await result.stats;
  console.log("\n\n📊 Performance Stats:", stats);

  await unloadModel({ modelId, clearStorage: false });
  process.exit(0);
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
