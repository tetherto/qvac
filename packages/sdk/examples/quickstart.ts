// The SDK prints no logs by default. To see its client and server logs, run with
// QVAC_CONFIG_PATH pointing at a config that sets "loggerConsoleOutput": true
// (see the Quickstart docs).
import {
  loadModel,
  LLAMA_3_2_1B_INST_Q4_0,
  completion,
  unloadModel,
} from "@qvac/sdk";

try {
  // Load a model into memory
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });

  // You can use the loaded model multiple times
  const history = [
    {
      role: "user",
      content: "Explain quantum computing in one sentence",
    },
  ];
  const result = completion({ modelId, history, stream: true });
  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }

  // Unload model to free up system resources
  await unloadModel({ modelId });
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
