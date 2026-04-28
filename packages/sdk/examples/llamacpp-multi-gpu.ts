import { completion, loadModel, unloadModel, VERBOSITY } from "@qvac/sdk";

// Multi-GPU inference distributes a model across multiple GPUs using llama.cpp's
// built-in split modes. Two strategies are available:
//
// - "layer": splits layers and KV cache across GPUs.
// - "row":   splits layers and KV cache across GPUs, and uses tensor parallelism
//            where supported.
//
// tensor-split controls the proportion of work assigned to each GPU.
// "1,1" distributes evenly across two GPUs; "3,1" assigns 75% to GPU 0.
//
// main-gpu selects which GPU is used for the entire model when split-mode is
// "none", and pins the primary device in multi-GPU mode.
// Accepts an integer device index (0, 1, ...) or "integrated" / "dedicated".

try {
  const modelId = await loadModel({
    modelSrc:
      "https://huggingface.co/Qwen/Qwen2.5-32B-Instruct-GGUF/resolve/main/qwen2.5-32b-instruct-q4_k_m-00001-of-00005.gguf",
    modelType: "llm",
    modelConfig: {
      "split-mode": "layer",
      "tensor-split": "1,1",
      "main-gpu": 0,
      ctx_size: 4096,
      gpu_layers: 99,
      verbosity: VERBOSITY.ERROR,
    },
    onProgress: (progress) => {
      if (progress.shardInfo) {
        const { shardInfo } = progress;
        console.log(
          `Downloading ${shardInfo.shardName} (${shardInfo.currentShard}/${shardInfo.totalShards}) ` +
            `— overall: ${shardInfo.overallPercentage.toFixed(1)}%`,
        );
      } else {
        console.log(`Downloading: ${progress.percentage.toFixed(1)}%`);
      }
    },
  });

  const history = [
    {
      role: "user",
      content: "Explain the difference between pipeline and tensor parallelism in one paragraph.",
    },
  ];

  const result = completion({ modelId, history, stream: true });

  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }

  const stats = await result.stats;
  console.log("\n\nStats:", stats);

  await unloadModel({ modelId, clearStorage: false });
  process.exit(0);
} catch (error) {
  console.error("Error:", error);
  process.exit(1);
}
