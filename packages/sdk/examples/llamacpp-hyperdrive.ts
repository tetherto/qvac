import {
  completion,
  LLAMA_3_2_1B_INST_Q4_0,
  loadModel,
  downloadAsset,
  unloadModel,
  VERBOSITY,
} from "@qvac/sdk";

try {
  // First just cache the model
  let lastBytes = 0;
  let lastTime = Date.now();
  await downloadAsset({
    assetSrc: LLAMA_3_2_1B_INST_Q4_0,
    onProgress: (progress) => {
      const now = Date.now();
      const elapsed = (now - lastTime) / 1000;
      if (elapsed >= 1) {
        const speed = (progress.downloaded - lastBytes) / elapsed / 1024 / 1024;
        const totalMB = progress.total / 1024 / 1024;
        const downloadedMB = progress.downloaded / 1024 / 1024;
        process.stdout.write(
          `\r${downloadedMB.toFixed(1)} / ${totalMB.toFixed(1)} MB  ${progress.percentage}%  ${speed.toFixed(1)} MB/s   `,
        );
        lastBytes = progress.downloaded;
        lastTime = now;
      }
    },
  });
  console.log();

  // Then load it in memory from cache
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    modelConfig: {
      device: "gpu",
      ctx_size: 2048,
      verbosity: VERBOSITY.ERROR,
    },
  });

  const history = [
    {
      role: "user",
      content: "Explain quantum computing in one sentence, use lots of emojis",
    },
  ];

  const result = completion({ modelId, history, stream: true });

  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }

  const stats = await result.stats;
  console.log("\n📊 Performance Stats:", stats);

  // Change `clearStorage: true` to delete cached model files
  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
