import {
  loadModel,
  unloadModel,
  diffusion,
  FLUX_2_KLEIN_4B_Q4_0,
  FLUX_2_KLEIN_4B_VAE,
  QWEN3_4B_Q4_K_M,
} from "@qvac/sdk";
import fs from "fs";
import path from "path";

const modelSrc = process.argv[2] || FLUX_2_KLEIN_4B_Q4_0;

const prompt =
  process.argv[3] ||
  "a photo of a cat sitting on a windowsill, golden hour lighting";
const outputDir = process.argv[4] || ".";

console.log(`▸ Loading diffusion model...`);
// FLUX.2 models require companion LLM + VAE models
const modelId = await loadModel({
  modelSrc,
  modelType: "sdcpp-generation",
  modelConfig: {
    device: "gpu",
    threads: 4,
    llmModelSrc: QWEN3_4B_Q4_K_M,
    vaeModelSrc: FLUX_2_KLEIN_4B_VAE,
  },
  onProgress: (p) => {
    const mb = (n: number) => (n / 1e6).toFixed(1);
    const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
    process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
    if (p.percentage >= 100) process.stderr.write("\n");
  },
});
console.log(`▸ Model loaded: ${modelId}`);

console.log(`▸ Generating: "${prompt}"`);

const { progressStream, outputs, stats } = diffusion({
  modelId,
  prompt,
  width: 512,
  height: 512,
  steps: 20,
  guidance: 3.5,
  cfg_scale: 1,
  seed: -1,
});

for await (const { step, totalSteps } of progressStream) {
  console.log(`▸ step ${step}/${totalSteps}`);
}

const buffers = await outputs;
for (let i = 0; i < buffers.length; i++) {
  const outputPath = path.join(outputDir, `output_${i}.png`);
  fs.writeFileSync(outputPath, buffers[i]!);
  console.log(`▸ Saved ${outputPath}`);
}

console.log("▸ Stats:", await stats);
await unloadModel({ modelId, clearStorage: false });
console.log("▸ Done");
process.exit(0);
