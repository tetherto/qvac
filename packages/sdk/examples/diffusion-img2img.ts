import { loadModel, unloadModel, generation, FLUX_2_KLEIN_4B_Q4_0, FLUX_2_KLEIN_4B_VAE, QWEN3_4B_Q4_K_M } from "@qvac/sdk";
import fs from "fs";
import path from "path";

const modelSrc = process.argv[2] || FLUX_2_KLEIN_4B_Q4_0;
const inputImagePath = process.argv[3] || path.resolve(import.meta.dirname, "image/test.jpg");

if (!fs.existsSync(inputImagePath)) {
  console.error(`Input image not found: ${inputImagePath}`);
  console.error(
    "Usage: bun run examples/diffusion-img2img.ts [model-src] [input-image] [prompt] [strength] [output-dir]",
  );
  process.exit(1);
}

const prompt = process.argv[4] || "watercolor painting style";
const strength = parseFloat(process.argv[5] || "0.75");
const outputDir = process.argv[6] || ".";

console.log(`Loading diffusion model...`);
// FLUX.2 models require companion LLM + VAE models
const modelId = await loadModel({
  modelSrc,
  modelType: "diffusion",
  modelConfig: { device: "gpu", threads: 4, llmModelSrc: QWEN3_4B_Q4_K_M, vaeModelSrc: FLUX_2_KLEIN_4B_VAE },
  onProgress: (p) => console.log(`Loading: ${p.percentage.toFixed(1)}%`),
});
console.log(`Model loaded: ${modelId}`);

console.log(`\nimg2img from: ${inputImagePath}`);
console.log(`Prompt: "${prompt}", strength: ${strength}`);

const { outputs, stats } = generation({
  modelId,
  prompt,
  init_image: fs.readFileSync(inputImagePath),
  strength,
  width: 512,
  height: 512,
  steps: 20,
  cfg_scale: 7.0,
});

const buffers = await outputs;
for (let i = 0; i < buffers.length; i++) {
  const outputPath = path.join(outputDir, `img2img_${i}.png`);
  fs.writeFileSync(outputPath, buffers[i]!);
  console.log(`Saved: ${outputPath}`);
}

console.log("\nStats:", await stats);
await unloadModel({ modelId, clearStorage: false });
console.log("Done.");
process.exit(0);
