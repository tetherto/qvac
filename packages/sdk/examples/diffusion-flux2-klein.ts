import { loadModel, unloadModel, diffusion, FLUX_2_KLEIN_4B_Q4_0, FLUX_2_KLEIN_4B_VAE, QWEN3_4B_Q4_K_M } from "@qvac/sdk";
import fs from "fs";
import path from "path";

// FLUX.2 [klein] uses a split-layout: separate diffusion model + LLM text encoder + VAE
const diffusionModelSrc = process.argv[2] || FLUX_2_KLEIN_4B_Q4_0;
const llmModelSrc = process.argv[3] || QWEN3_4B_Q4_K_M;
const vaeModelSrc = process.argv[4] || FLUX_2_KLEIN_4B_VAE;
const prompt = process.argv[5] || "a futuristic city at sunset, photorealistic";
const outputDir = process.argv[6] || ".";

console.log("Loading FLUX.2 [klein] split-layout model...");

const modelId = await loadModel({
  modelSrc: diffusionModelSrc,
  modelType: "diffusion",
  modelConfig: {
    device: "gpu",
    threads: 4,
    llmModelSrc,
    vaeModelSrc,
  },
  onProgress: (p) => console.log(`Loading: ${p.percentage.toFixed(1)}%`),
});
console.log(`Model loaded: ${modelId}`);

console.log(`\nGenerating: "${prompt}"`);

const { progressStream, outputs, stats } = diffusion({
  modelId,
  prompt,
  width: 512,
  height: 512,
  steps: 20,
  guidance: 3.5,
  seed: -1,
});

for await (const { step, totalSteps } of progressStream) {
  process.stdout.write(`\rStep ${step}/${totalSteps}`);
}
console.log();

const buffers = await outputs;
for (let i = 0; i < buffers.length; i++) {
  const outputPath = path.join(outputDir, `flux2_${i}.png`);
  fs.writeFileSync(outputPath, buffers[i]!);
  console.log(`Saved: ${outputPath}`);
}

console.log("\nStats:", await stats);
await unloadModel({ modelId, clearStorage: false });
console.log("Done.");
process.exit(0);
