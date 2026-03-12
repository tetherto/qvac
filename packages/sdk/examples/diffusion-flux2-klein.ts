import { loadModel, unloadModel, generation } from "@qvac/sdk";
import fs from "fs";
import path from "path";

// FLUX.2 [klein] uses a split-layout: separate diffusion model + LLM text encoder
const diffusionModelPath = process.argv[2];
const llmModelPath = process.argv[3];

if (!diffusionModelPath || !llmModelPath) {
  console.error(
    "Usage: bun run examples/diffusion-flux2-klein.ts <diffusion-gguf> <llm-gguf> [vae-path] [prompt] [output-dir]",
  );
  process.exit(1);
}

const vaePath = process.argv[4] || undefined;
const prompt = process.argv[5] || "a futuristic city at sunset, photorealistic";
const outputDir = process.argv[6] || ".";

console.log("Loading FLUX.2 [klein] split-layout model...");
console.log(`  Diffusion: ${diffusionModelPath}`);
console.log(`  LLM encoder: ${llmModelPath}`);
if (vaePath) console.log(`  VAE: ${vaePath}`);

const modelId = await loadModel({
  modelSrc: diffusionModelPath,
  modelType: "diffusion",
  modelConfig: {
    device: "cpu",
    threads: 4,
    llmModelSrc: llmModelPath,
    ...(vaePath ? { vaeModelSrc: vaePath } : {}),
  },
  onProgress: (p) => console.log(`Loading: ${p.percentage.toFixed(1)}%`),
});
console.log(`Model loaded: ${modelId}`);

console.log(`\nGenerating: "${prompt}"`);

const { outputStream, stats } = generation({
  modelId,
  prompt,
  width: 512,
  height: 512,
  steps: 20,
  guidance: 3.5,
  seed: -1,
  stream: true,
});

for await (const { data, outputIndex } of outputStream) {
  const outputPath = path.join(outputDir, `flux2_${outputIndex}.png`);
  fs.writeFileSync(outputPath, Buffer.from(data, "base64"));
  console.log(`Saved: ${outputPath}`);
}

console.log("\nStats:", await stats);
await unloadModel({ modelId, clearStorage: false });
console.log("Done.");
process.exit(0);
