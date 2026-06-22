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
  await downloadAsset({
    assetSrc: LLAMA_3_2_1B_INST_Q4_0,
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });

  // Then load it in memory from cache
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
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
  console.log("\n▸ Performance Stats:", stats);

  // Change `clearStorage: true` to delete cached model files
  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
