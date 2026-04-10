import {
  completion,
  loadModel,
  unloadModel,
  LLAMA_3_2_1B_INST_Q4_0,
  SDK_SERVER_ERROR_CODES,
} from "@qvac/sdk";

const requestedCtxSize = Number(process.argv[2]) || 32768;

console.log(`Loading model: ${LLAMA_3_2_1B_INST_Q4_0.name}`);
console.log(`Requested ctx_size: ${requestedCtxSize}`);

try {
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    modelConfig: {
      ctx_size: requestedCtxSize,
    },
    onProgress: (progress) =>
      console.log(`Loading: ${progress.percentage.toFixed(1)}%`),
  });

  console.log(`Model loaded with ctx_size=${requestedCtxSize}`);

  const result = completion({
    modelId,
    history: [{ role: "user", content: "Say hello in one sentence." }],
    stream: true,
  });

  process.stdout.write("Response: ");
  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }
  console.log();

  await unloadModel({ modelId, clearStorage: false });
} catch (error: unknown) {
  if (
    error instanceof Error &&
    "code" in error &&
    (error as { code: number }).code ===
      SDK_SERVER_ERROR_CODES.MODEL_MEMORY_EXCEEDED
  ) {
    console.error(`\nMemory validation failed: ${error.message}`);
    console.error(
      "The SDK detected that loading with the requested ctx_size",
    );
    console.error(
      "would likely exceed available memory and crash the app.",
    );
    console.error("Re-run with a smaller ctx_size, for example:");
    console.error(`  bun run examples/memory-safe-loading.ts 2048`);
  } else {
    console.error("Error:", error);
  }
  process.exit(1);
}
