import { completion, loadModel, unloadModel } from "@qvac/sdk";

// Get GGUF file path from command line arguments
const ggufPath = process.argv[2];

if (!ggufPath) {
  console.error(
    "✖ Please provide the path to a GGUF file as the first argument",
  );
  console.error(
    "✖ Usage: bun run examples/llamacpp-filesystem.ts <path-to-gguf-file>",
  );
  process.exit(1);
}

console.log(`▸ Loading GGUF model from: ${ggufPath}`);

try {
  // Load model from provided file path
  const modelId = await loadModel({
    modelSrc: ggufPath,
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
    { role: "user", content: "Explain Bitcoin in 3 key points" },
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
