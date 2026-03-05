/**
 * Default Config Example
 *
 * This example demonstrates how to use a config file with the SDK.
 *
 * Supported config formats:
 * - qvac.config.json (JSON)
 * - qvac.config.js   (JavaScript with default export)
 * - qvac.config.ts   (TypeScript with default export)
 *
 * Config resolution order:
 * 1. QVAC_CONFIG_PATH environment variable (used here for demo purposes)
 * 2. Config file in project root - auto-discovered, no env var needed
 * 3. SDK defaults
 */

// Note: This example uses .js file for the config
// However it could be .json or .ts as well, depending on your needs.
const configDir = import.meta.dirname ?? process.cwd();
process.env["QVAC_CONFIG_PATH"] =
  `${configDir}/config/default/default.config.js`;

console.log(`🔍 Using config from: ${process.env["QVAC_CONFIG_PATH"]}`);

const { loadModel, unloadModel, completion, LLAMA_3_2_1B_INST_Q4_0 } =
  await import("@qvac/sdk");

try {
  console.log("🚀 Loading model with configured settings...\n");

  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
  });

  console.log("\n💬 Running completion...\n");

  const result = completion({
    modelId,
    history: [
      { role: "user", content: "Say 'Config works!' in exactly 3 words." },
    ],
    stream: true,
  });

  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }
  console.log("\n");

  await unloadModel({ modelId });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
