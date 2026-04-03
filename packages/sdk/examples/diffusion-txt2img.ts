import { loadModel, unloadModel, diffusion, FLUX_2_KLEIN_4B_Q4_0, FLUX_2_KLEIN_4B_VAE, QWEN3_4B_Q4_K_M } from "@qvac/sdk";
import fs from "fs";
import path from "path";

const modelSrc = process.argv[2] || FLUX_2_KLEIN_4B_Q4_0;

const prompt =
  process.argv[3] ||
  "a photo of a cat sitting on a windowsill, golden hour lighting";
const outputDir = process.argv[4] || ".";

console.log(`Loading diffusion model...`);
// FLUX.2 models require companion LLM + VAE models
const modelId = await loadModel({
  modelSrc,
  modelType: "diffusion",
  modelConfig: { device: "gpu", threads: 4, llmModelSrc: QWEN3_4B_Q4_K_M, vaeModelSrc: FLUX_2_KLEIN_4B_VAE },
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
  cfg_scale: 7.0,
  seed: -1,
});

for await (const { step, totalSteps } of progressStream) {
  process.stdout.write(`\rStep ${step}/${totalSteps}`);
}
console.log();

const buffers = await outputs;
for (let i = 0; i < buffers.length; i++) {
  const outputPath = path.join(outputDir, `output_${i}.png`);
  fs.writeFileSync(outputPath, buffers[i]!);
  console.log(`Saved: ${outputPath}`);
}

console.log("\nStats:", await stats);
await unloadModel({ modelId, clearStorage: false });
console.log("Done.");
process.exit(0);
