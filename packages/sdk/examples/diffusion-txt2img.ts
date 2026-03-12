import { loadModel, unloadModel, generation } from "@qvac/sdk";
import fs from "fs";
import path from "path";

const modelPath = process.argv[2];

if (!modelPath) {
  console.error(
    "Usage: bun run examples/diffusion-txt2img.ts <path-to-sd-gguf> [prompt] [output-dir]",
  );
  process.exit(1);
}

const prompt =
  process.argv[3] ||
  "a photo of a cat sitting on a windowsill, golden hour lighting";
const outputDir = process.argv[4] || ".";

console.log(`Loading diffusion model from: ${modelPath}`);
const modelId = await loadModel({
  modelSrc: modelPath,
  modelType: "diffusion",
  modelConfig: { device: "cpu", threads: 4 },
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
  cfg_scale: 7.0,
  seed: -1,
  stream: true,
});

for await (const { data, outputIndex } of outputStream) {
  const outputPath = path.join(outputDir, `output_${outputIndex}.png`);
  fs.writeFileSync(outputPath, Buffer.from(data, "base64"));
  console.log(`Saved: ${outputPath}`);
}

console.log("\nStats:", await stats);
await unloadModel({ modelId, clearStorage: false });
console.log("Done.");
process.exit(0);
