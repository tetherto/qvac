import { completion, loadModel, unloadModel } from "@qvac/sdk";

// Get HTTP URL from command line arguments or use default HuggingFace URL
const httpUrl =
  process.argv[2] ||
  "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf";

console.log(`▸ Loading GGUF model from HTTP: ${httpUrl}`);

try {
  // Load model from HTTP URL
  const modelId = await loadModel({
    modelSrc: httpUrl,
    modelType: "llamacpp-completion",
    modelConfig: {
      ctx_size: 4096,
    },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });
  console.log(`▸ Model loaded successfully! Model ID: ${modelId}`);

  // Create conversation history
  const history = [
    { role: "user", content: "Explain quantum computing in 3 key points" },
  ];

  console.log("\n▸ AI Response:");
  process.stdout.write(""); // Start response on new line

  // Stream completion
  const result = completion({ modelId, history, stream: true });

  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }

  const stats = await result.stats;
  console.log("\n▸ Performance Stats:", stats);
  console.log("\n\n▸ Completed!");

  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
