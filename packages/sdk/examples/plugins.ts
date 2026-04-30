/**
 * Plugin Selection Example
 *
 * Config: examples/config/plugins/plugins.config.json
 *   Selected: llamacpp-completion (LLM), nmtcpp-translation (NMT)
 *
 * Demonstrates:
 *   1. LLM completion    -> works (plugin selected)
 *   2. NMT translation   -> works (plugin selected)
 *   3. Embeddings        -> fails (plugin not selected)
 *
 */

import { execSync } from "child_process";
import { existsSync, rmSync } from "fs";
import path from "path";

const configDir = import.meta.dirname ?? process.cwd();
const configPath = `${configDir}/config/plugins/plugins.config.json`;
const projectRoot = path.resolve(configDir, "..");
const qvacOutputDir = path.join(projectRoot, "qvac");

// ─── Generate the worker bundle from the plugins config ─────────────────────

console.log(`🔍 Config: ${configPath}`);
console.log(
  `⚠️  This example will generate a worker bundle in ${qvacOutputDir} and delete it on exit.`,
);
console.log(
  "   If you have an existing qvac/ folder with bundled files, they will be overwritten and removed.\n",
);
console.log("🔨 Generating worker bundle from plugins config...\n");

try {
  execSync(`npx @qvac/cli bundle sdk --config "${configPath}" --quiet`, {
    cwd: projectRoot,
    stdio: "inherit",
  });
} catch (error) {
  console.error(
    "❌ Failed to generate worker bundle. Ensure @qvac/cli is installed:",
  );
  console.error("   npm install -D @qvac/cli");
  console.error("❌ Error:", error);
  process.exit(1);
}

console.log("");

// Cleanup generated qvac/ folder on exit
function cleanup() {
  if (existsSync(qvacOutputDir)) {
    rmSync(qvacOutputDir, { recursive: true, force: true });
    console.log(`\n🧹 Cleaned up ${qvacOutputDir}`);
  }
}
process.on("exit", cleanup);

// Point config before importing the SDK.
// In a real app, place qvac.config.json (or .js/.ts) in your project root (auto-discovered).
process.env["QVAC_CONFIG_PATH"] = configPath;

const {
  completion,
  translate,
  embed,
  loadModel,
  unloadModel,
  LLAMA_3_2_1B_INST_Q4_0,
  BERGAMOT_EN_ES,
  GTE_LARGE_FP16,
} = await import("@qvac/sdk");

console.log("1. LLM Completion (llamacpp-completion plugin)");

try {
  const llmModelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    modelConfig: { ctx_size: 2048 },
    onProgress: (p) =>
      console.log(`   Loading LLM: ${p.percentage.toFixed(1)}%`),
  });

  console.log(`   Model loaded: ${llmModelId}`);

  const question = "What is 2 + 2? Answer in one word.";
  console.log(`   Question: ${question}`);

  const result = completion({
    modelId: llmModelId,
    history: [{ role: "user", content: question }],
    stream: true,
  });

  process.stdout.write("   Response: ");
  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }
  console.log("\n");

  await unloadModel({ modelId: llmModelId });
  console.log("   ✅ LLM unloaded\n");
} catch (error) {
  console.error("   ❌ LLM failed:", error);
  process.exit(1);
}

console.log("2. Translation (nmtcpp-translation plugin)");

try {
  const nmtModelId = await loadModel({
    modelSrc: BERGAMOT_EN_ES,
    modelType: "nmt",
    modelConfig: {
      engine: "Bergamot",
      from: "en",
      to: "es",
    },
    onProgress: (p) =>
      console.log(`   Loading NMT: ${p.percentage.toFixed(1)}%`),
  });

  console.log(`   Model loaded: ${nmtModelId}`);

  const text = "Hello, how are you?";
  const result = translate({
    modelId: nmtModelId,
    text,
    modelType: "nmt",
    stream: false,
  });

  const translated = await result.text;
  console.log(`   "${text}" -> "${translated}"\n`);

  await unloadModel({ modelId: nmtModelId });
  console.log("   ✅ NMT unloaded\n");
} catch (error) {
  console.error("   ❌ Translation failed:", error);
  process.exit(1);
}

console.log("3. Embeddings (llamacpp-embedding plugin NOT in config)");
console.log("   Attempting to load an embeddings model...\n");

try {
  const embedModelId = await loadModel({
    modelSrc: GTE_LARGE_FP16,
    modelType: "embeddings",
  });

  await embed({ modelId: embedModelId, text: "test" });

  console.error("   ❌ Unexpected: embed succeeded without the plugin!");
  process.exit(1);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("Plugin not found")) {
    console.log("   ✅ Expected PLUGIN_NOT_FOUND error:");
    console.log(`   ${message}\n`);
  } else {
    console.error("   ❌ Unexpected error:", error);
    process.exit(1);
  }
}

console.log("Done! Only the selected plugins were available.");
