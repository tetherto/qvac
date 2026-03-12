import { loadModel, unloadModel, generation } from "@qvac/sdk";
import fs from "fs";
import path from "path";

const modelPath = process.argv[2];
const inputImagePath = process.argv[3];

if (!modelPath || !inputImagePath) {
  console.error(
    "Usage: bun run examples/diffusion-img2img.ts <path-to-sd-gguf> <input-image> [prompt] [strength] [output-dir]",
  );
  process.exit(1);
}

const prompt = process.argv[4] || "watercolor painting style";
const strength = parseFloat(process.argv[5] || "0.75");
const outputDir = process.argv[6] || ".";

console.log(`Loading diffusion model from: ${modelPath}`);
const modelId = await loadModel({
  modelSrc: modelPath,
  modelType: "diffusion",
  modelConfig: { device: "cpu", threads: 4 },
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
