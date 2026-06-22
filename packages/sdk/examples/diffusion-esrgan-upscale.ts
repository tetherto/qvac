import {
  loadModel,
  unloadModel,
  diffusion,
  SD_V2_1_1B_Q8_0,
  REALESRGAN_X4PLUS_ANIME_6B,
} from "@qvac/sdk";
import fs from "fs";
import path from "path";

// ESRGAN upscale example.
//
// Usage:
//   bun run examples/diffusion-esrgan-upscale.ts [esrganSrc] [prompt] [outputDir]

const esrganArg: string | undefined = process.argv[2];
const promptArg: string | undefined = process.argv[3];
const outputDirArg: string | undefined = process.argv[4];

const esrganModelSrc = esrganArg ?? REALESRGAN_X4PLUS_ANIME_6B;

const prompt =
  promptArg ??
  "an illustrated red fox portrait, clean line art, soft watercolor background, detailed fur, crisp eyes";
const negative_prompt = "blurry, low quality, watermark, text";
const outputDir = outputDirArg ?? ".";
const seed = 42;

try {
  console.log("▸ Loading SD 2.1 + ESRGAN upscaler...");
  const modelId = await loadModel({
    modelSrc: SD_V2_1_1B_Q8_0,
    modelConfig: {
      prediction: "v",
      upscaler: {
        type: "esrgan",
        model_src: esrganModelSrc,
        tile_size: 128,
      },
    },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });
  console.log(`▸ Model loaded: ${modelId}`);

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

  console.log(`▸ Generating ESRGAN x4 upscale: "${prompt}"`);
  const single = diffusion({ ...baseParams, upscale: true });
  for await (const { step, totalSteps } of single.progressStream) {
    console.log(`▸ step ${step}/${totalSteps}`);
  }

  const singleBuffers = await single.outputs;
  for (let i = 0; i < singleBuffers.length; i++) {
    const out = path.join(outputDir, `sd2_esrgan_x4_seed${seed}_${i}.png`);
    fs.writeFileSync(out, singleBuffers[i]!);
    console.log(`▸ Saved ${out}`);
  }
  console.log("▸ Stats:", await single.stats);

  console.log("▸ Generating ESRGAN two-pass x16 upscale...");
  const twoPass = diffusion({ ...baseParams, upscale: { repeats: 2 } });
  for await (const { step, totalSteps } of twoPass.progressStream) {
    console.log(`▸ step ${step}/${totalSteps}`);
  }

  const twoPassBuffers = await twoPass.outputs;
  for (let i = 0; i < twoPassBuffers.length; i++) {
    const out = path.join(outputDir, `sd2_esrgan_x16_seed${seed}_${i}.png`);
    fs.writeFileSync(out, twoPassBuffers[i]!);
    console.log(`▸ Saved ${out}`);
  }
  console.log("▸ Stats:", await twoPass.stats);

  await unloadModel({ modelId, clearStorage: false });
  console.log("▸ Done");
  process.exit(0);
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
