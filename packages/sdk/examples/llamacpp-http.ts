import { completion, loadModel, unloadModel } from "@qvac/sdk";

// Get HTTP URL from command line arguments or use default HuggingFace URL
const httpUrl =
  process.argv[2] ||
  "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf";

console.log(`🚀 Loading GGUF model from HTTP: ${httpUrl}`);

try {
  // Load model from HTTP URL
  const modelId = await loadModel({
    modelSrc: httpUrl,
    modelType: "llm",
    modelConfig: {
      ctx_size: 4096,
    },
    onProgress: (progress) => {
      const downloadedMB = (progress.downloaded / 1024 / 1024).toFixed(2);
      const totalMB = (progress.total / 1024 / 1024).toFixed(2);
      console.log(
        `Loading: ${progress.percentage.toFixed(1)}% (${downloadedMB}MB / ${totalMB}MB)`,
      );
    },
  });
  console.log(`✅ Model loaded successfully! Model ID: ${modelId}`);

  // Create conversation history
  const history = [
    { role: "user", content: "Explain quantum computing in 3 key points" },
  ];

  console.log("\n🤖 AI Response:");
  process.stdout.write(""); // Start response on new line

  // Stream completion
  const result = completion({ modelId, history, stream: true });

  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }

  const stats = await result.stats;
  console.log("\n📊 Performance Stats:", stats);
  console.log("\n\n🎉 Completed!");

  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
