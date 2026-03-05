import { completion, loadModel, unloadModel, VERBOSITY } from "@qvac/sdk";

// Sharded models can be loaded from:
// 1. HTTP archives: "https://example.com/model.tar.gz"
// 2. HTTP pattern: "https://example.com/model-00001-of-00005.gguf"
// 3. Hyperdrive: use any sharded model source/constant, eg: LLAMA_3_2_1B_INST_Q4_0_SHARD
// 4. Local filesystem: pass the path to the first shard file (Note: All shards must be in the same directory)
// 5. Local archive: pass the path to the archive file (.tar, .tar.gz, .tgz)

try {
  const modelId = await loadModel({
    modelSrc:
      "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf",
    modelType: "llm",
    modelConfig: {
      device: "gpu",
      ctx_size: 2048,
      verbosity: VERBOSITY.ERROR,
    },
    onProgress: (progress) => {
      // For sharded models, progress.shardInfo contains detailed progress for both
      // individual shards AND overall download progress across all shards
      if (progress.shardInfo) {
        // For pattern-based or Hyperdrive shards
        const { shardInfo } = progress;

        console.log(
          `📥 Downloading ${shardInfo.shardName} (${shardInfo.currentShard}/${shardInfo.totalShards})\n` +
            `   File: ${progress.percentage.toFixed(1)}% (${(progress.downloaded / 1024 / 1024).toFixed(2)}MB / ${(progress.total / 1024 / 1024).toFixed(2)}MB)\n` +
            `   Overall: ${shardInfo.overallPercentage.toFixed(1)}% (${(shardInfo.overallDownloaded / 1024 / 1024).toFixed(2)}MB / ${(shardInfo.overallTotal / 1024 / 1024).toFixed(2)}MB)`,
        );
      } else {
        // For archive-based shards
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
