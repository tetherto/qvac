import { completion, loadModel, unloadModel } from "@qvac/sdk";

// Get GGUF file path from command line arguments
const ggufPath = process.argv[2];

if (!ggufPath) {
  console.error(
    "❌ Error: Please provide the path to a GGUF file as the first argument",
  );
  console.error(
    "Usage: bun run examples/llamacpp-filesystem.ts <path-to-gguf-file>",
  );
  process.exit(1);
}

console.log(`🚀 Loading GGUF model from: ${ggufPath}`);

try {
  // Load model from provided file path
  const modelId = await loadModel({
    modelSrc: ggufPath,
    modelType: "llm",
    modelConfig: {
      ctx_size: 4096,
    },
    onProgress: (progress) =>
      console.log(`Loading: ${progress.percentage.toFixed(1)}%`),
  });
  console.log(`✅ Model loaded successfully! Model ID: ${modelId}`);

  // Create conversation history
  const history = [
    { role: "user", content: "Explain Bitcoin in 3 key points" },
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
