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

// img2img with FLUX.2 [klein] split-layout — uses in-context conditioning ("flux2_flow").

const inputPath = process.argv[2];
const prompt = process.argv[3] || "oil painting style, vibrant colors";
const outputDir = process.argv[4] || ".";
const diffusionModelSrc = process.argv[5] || FLUX_2_KLEIN_4B_Q4_0;
const llmModelSrc = process.argv[6] || QWEN3_4B_Q4_K_M;
const vaeModelSrc = process.argv[7] || FLUX_2_KLEIN_4B_VAE;

if (!inputPath) {
  console.error("✖ input image path is required");
  console.error(
    "Usage: bun run bare:example dist/examples/diffusion-flux2-klein-img2img.js <inputImage> [prompt] [outputDir] [diffusionModelSrc] [llmModelSrc] [vaeModelSrc]",
  );
  process.exit(1);
}

try {
  console.log("▸ Loading FLUX.2 [klein] split-layout model...");
  const modelId = await loadModel({
    modelSrc: diffusionModelSrc,
    modelType: "sdcpp-generation",
    modelConfig: {
      device: "gpu",
      threads: 4,
      llmModelSrc,
      vaeModelSrc,
      prediction: "flux2_flow",
    },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });
  console.log(`▸ Model loaded: ${modelId}`);

  const init_image = new Uint8Array(fs.readFileSync(inputPath));
  console.log(`▸ Transforming "${inputPath}" with prompt: "${prompt}"`);

  const { progressStream, outputs, stats } = diffusion({
    modelId,
    prompt,
    init_image,
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
    const outputPath = path.join(outputDir, `flux2_img2img_${i}.png`);
    fs.writeFileSync(outputPath, buffers[i]!);
    console.log(`▸ Saved ${outputPath}`);
  }

  console.log("▸ Stats:", await stats);
  await unloadModel({ modelId, clearStorage: false });
  console.log("▸ Done");
  process.exit(0);
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
