import { loadModel, unloadModel, diffusion, SD_V2_1_1B_Q8_0 } from "@qvac/sdk";
import fs from "fs";
import path from "path";

// img2img example — transforms an input image guided by a text prompt.

const inputPath = process.argv[2];
const prompt = process.argv[3] || "oil painting style, vibrant colors";
const outputDir = process.argv[4] || ".";
const modelSrc = process.argv[5] || SD_V2_1_1B_Q8_0;

if (!inputPath) {
  console.error("❌ Error: input image path is required");
  console.error("Usage: bun run bare:example dist/examples/diffusion-img2img.js <inputImage> [prompt] [outputDir] [modelSrc]");
  process.exit(1);
}

try {
  console.log("Loading diffusion model...");
  const modelId = await loadModel({
    modelSrc,
    modelType: "diffusion",
  });
  console.log(`Model loaded: ${modelId}`);

  const init_image = new Uint8Array(fs.readFileSync(inputPath));
  console.log(`\nTransforming "${inputPath}" with prompt: "${prompt}"`);

  const { progressStream, outputs, stats } = diffusion({
    modelId,
    prompt,
    init_image,
    strength: 0.5,
    steps: 30,
    seed: -1,
  });

  for await (const { step, totalSteps } of progressStream) {
    process.stdout.write(`\rStep ${step}/${totalSteps}`);
  }
  console.log();

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
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
