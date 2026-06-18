// The SDK is silent by default. Pointing QVAC_CONFIG_PATH at a config with
// `loggerConsoleOutput: true` prints the SDK's client and server logs to the
// console. Drop this line (or set the flag to false) to run quietly.
const configDir = import.meta.dirname ?? process.cwd();
process.env["QVAC_CONFIG_PATH"] =
  `${configDir}/config/default/default.config.json`;

const { loadModel, LLAMA_3_2_1B_INST_Q4_0, completion, unloadModel } =
  await import("@qvac/sdk");

try {
  // Load a model into memory
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    onProgress: (progress) => {
      console.log(progress);
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
  console.error("❌ Error:", error);
  process.exit(1);
}
