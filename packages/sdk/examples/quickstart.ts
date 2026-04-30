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
    modelType: "llm",
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
