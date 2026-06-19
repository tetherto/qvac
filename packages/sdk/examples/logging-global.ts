// loggerConsoleOutput: false in this config disables the default console
// transport on both the client and the worker, so the only logs printed are
// the ones our handler below receives.
const configDir = import.meta.dirname ?? process.cwd();
process.env["QVAC_CONFIG_PATH"] = `${configDir}/config/logging/logging.config.json`;

const { loadModel, completion, unloadModel, subscribeServerLogs, LLAMA_3_2_1B_INST_Q4_0 } =
  await import("@qvac/sdk");

try {
  console.log("▸ Starting global logging demo...\n");

  // One subscription captures every server-side log (SDK, models, RAG, …)
  // without having to know any stream IDs ahead of time.
  const unsubscribe = subscribeServerLogs((log) => {
    console.log(`[SDK] [${log.level.toUpperCase()}] [${log.namespace}] ${log.message}`);
  });

  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelConfig: { ctx_size: 2048 },
  });

  const result = completion({
    modelId,
    history: [{ role: "user", content: "Count from 1 to 5." }],
    stream: true,
  });

  console.log("▸ Response:\n");
  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }

  await unloadModel({ modelId, clearStorage: false });
  unsubscribe();
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
