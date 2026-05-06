import {
  downloadAsset,
  loadModel,
  unloadModel,
  diffusion,
  SD_V2_1_1B_Q8_0,
} from "@qvac/sdk";
import fs from "fs";
import path from "path";

// ESRGAN upscale example. Downloads the RealESRGAN_x4plus_anime_6B weights via
// the SDK download cache, then passes the same source through `esrganModelSrc`.
//
// Usage:
//   bun run examples/diffusion-esrgan-upscale.ts [esrganSrc] [prompt] [outputDir]
//   ESRGAN_MODEL_PATH=/path/to/weights.pth bun run examples/diffusion-esrgan-upscale.ts
const ESRGAN_DOWNLOAD_URL =
  "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth";

const esrganArg: string | undefined = process.argv[2];
const promptArg: string | undefined = process.argv[3];
const outputDirArg: string | undefined = process.argv[4];

const esrganModelSrc: string =
  esrganArg ??
  (process.env["ESRGAN_MODEL_PATH"] as string | undefined) ??
  ESRGAN_DOWNLOAD_URL;

const prompt =
  promptArg ??
  "an illustrated red fox portrait, clean line art, soft watercolor background, detailed fur, crisp eyes";
const negative_prompt = "blurry, low quality, watermark, text";
const outputDir = outputDirArg ?? ".";
const seed = 42;

function formatMB(bytes: number) {
  return (bytes / 1024 / 1024).toFixed(2);
}

try {
  console.log("Downloading ESRGAN upscaler weights...");
  await downloadAsset({
    assetSrc: esrganModelSrc,
    onProgress: (progress) => {
      const downloadedMB = formatMB(progress.downloaded);
      const totalMB = formatMB(progress.total);
      const percentage = progress.percentage.toFixed(1);

      console.log(
        `Progress: ${percentage}% (${downloadedMB}MB / ${totalMB}MB)`,
      );
    },
  });
  console.log("ESRGAN weights ready.");

  console.log("Loading SD 2.1 + ESRGAN upscaler...");
  const modelId = await loadModel({
    modelSrc: SD_V2_1_1B_Q8_0,
    modelType: "diffusion",
    modelConfig: {
      prediction: "v",
      esrganModelSrc,
      upscaler_tile_size: 128,
    },
    onProgress: (p) => console.log(`Loading: ${p.percentage.toFixed(1)}%`),
  });
  console.log(`Model loaded: ${modelId}`);

  // Source size is intentionally small — each ESRGAN repeat multiplies dimensions.
  const baseParams = {
    modelId,
    prompt,
    negative_prompt,
    width: 128,
    height: 128,
    steps: 5,
    cfg_scale: 7.5,
    seed,
  };

  console.log(`\nGenerating ESRGAN x4 upscale: "${prompt}"`);
  const single = diffusion({ ...baseParams, upscale: true });
  for await (const { step, totalSteps } of single.progressStream) {
    process.stdout.write(`\rStep ${step}/${totalSteps}\x1b[K`);
  }
  console.log();

  const singleBuffers = await single.outputs;
  for (let i = 0; i < singleBuffers.length; i++) {
    const out = path.join(outputDir, `sd2_esrgan_x4_seed${seed}_${i}.png`);
    fs.writeFileSync(out, singleBuffers[i]!);
    console.log(`Saved: ${out}`);
  }
  console.log("Stats:", await single.stats);

  console.log("\nGenerating ESRGAN two-pass x16 upscale...");
  const twoPass = diffusion({ ...baseParams, upscale: { repeats: 2 } });
  for await (const { step, totalSteps } of twoPass.progressStream) {
    process.stdout.write(`\rStep ${step}/${totalSteps}\x1b[K`);
  }
  console.log();

  const twoPassBuffers = await twoPass.outputs;
  for (let i = 0; i < twoPassBuffers.length; i++) {
    const out = path.join(outputDir, `sd2_esrgan_x16_seed${seed}_${i}.png`);
    fs.writeFileSync(out, twoPassBuffers[i]!);
    console.log(`Saved: ${out}`);
  }
  console.log("Stats:", await twoPass.stats);

  await unloadModel({ modelId, clearStorage: false });
  console.log("Done.");
  process.exit(0);
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
