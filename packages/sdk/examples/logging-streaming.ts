import {
  loadModel,
  completion,
  unloadModel,
  loggingStream,
  SDK_LOG_ID,
  LLAMA_3_2_1B_INST_Q4_0,
  GTE_LARGE_FP16,
  VERBOSITY,
  embed,
} from "@qvac/sdk";

try {
  console.log("🚀 Starting log streaming demo...\n");

  // Note: To configure logging (level and console output), use config file:
  // { "loggerLevel": "debug", "loggerConsoleOutput": false } in qvac.config.json/js/ts

  // Subscribe to SDK server logs in background
  console.log("📡 Starting SDK server log stream...\n");
  (async () => {
    for await (const log of loggingStream({ id: SDK_LOG_ID })) {
      console.log(
        `[SDK] [${log.level.toUpperCase()}] [${log.namespace}] ${log.message}`,
      );
    }
  })().catch(() => {
    // Stream terminated - normal on shutdown
  });

  // Load models
  console.log("📥 Loading models (watch SDK logs above)...\n");
  const llmModelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    modelConfig: {
      ctx_size: 2048,
      temp: 0.7,
      verbosity: VERBOSITY.ERROR, // Only log errors, remaining logs are captured by loggingStream
    },
  });

  const embedModelId = await loadModel({
    modelSrc: GTE_LARGE_FP16,
    modelType: "embeddings",
  });

  console.log("📡 Starting model-specific log streams...\n");
  (async () => {
    for await (const log of loggingStream({ id: llmModelId })) {
      const timestamp = new Date(log.timestamp).toISOString();
      console.log(
        `[LLM] [${timestamp}] [${log.level.toUpperCase()}] ${log.namespace}: ${log.message}`,
      );
    }
  })().catch(() => {
    // Stream terminated - this is normal when model unloads
  });

  (async () => {
    for await (const log of loggingStream({ id: embedModelId })) {
      const timestamp = new Date(log.timestamp).toISOString();
      console.log(
        `[EMBED] [${timestamp}] [${log.level.toUpperCase()}] ${log.namespace}: ${log.message}`,
      );
    }
  })().catch(() => {
    // Stream terminated - this is normal when model unloads
  });
  const messages = [
    { role: "user", content: "Count from 1 to 5 and explain each number." },
  ];

  const result = completion({
    modelId: llmModelId,
    history: messages,
    stream: true,
  });
  const { embedding } = await embed({
    modelId: embedModelId,
    text: messages[0]?.content ?? "Hello, world!",
  });

  console.log("📝 Response:\n");
  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }

  console.log("Embedding (first 20 elements)", embedding.slice(0, 20));
  console.log("Embeddings length", embedding.length);

  console.log(
    "\n💡 Notice three log streams running:\n" +
      "   - [SDK] = SDK server operations\n" +
      "   - [LLM] = LLM model inference logs\n" +
      "   - [EMBED] = Embedding model logs\n",
  );

  await unloadModel({ modelId: llmModelId, clearStorage: false });
  await unloadModel({ modelId: embedModelId, clearStorage: false });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
