import {
  loadModel,
  unloadModel,
  video,
  WAN2_1_I2V_14B_Q4_K_M,
  CLIP_VISION_H,
  UMT5_XXL_FP16,
  WAN_2_1_COMFYUI_REPACKAGED_VAE,
} from "@qvac/sdk";
import fs from "fs";
import path from "path";

// Image-to-video with Wan 2.1 I2V. Requires a Wan I2V diffusion checkpoint (GGUF
// recommended), plus UMT5-XXL, Wan VAE, and CLIP vision weights. The model
// sources default to the bundled registry constants, so the common case is just
// an init image path.
const initImagePath = process.argv[2];
const prompt =
  process.argv[3] ||
  "the subject slowly turns and smiles, soft natural lighting, cinematic";
const outputDir = process.argv[4] || ".";
const diffusionModelSrc = process.argv[5] || WAN2_1_I2V_14B_Q4_K_M;
const t5XxlModelSrc = process.argv[6] || UMT5_XXL_FP16;
const vaeModelSrc = process.argv[7] || WAN_2_1_COMFYUI_REPACKAGED_VAE;
const clipVisionModelSrc = process.argv[8] || CLIP_VISION_H;

if (!initImagePath) {
  console.error("✖ init image path is required");
  console.error(
    "Usage: bun run bare:example dist/examples/diffusion-img2vid.js " +
    "<initImagePath> [prompt] [outputDir] " +
    "[i2vModelSrc] [t5XxlModelSrc] [vaeModelSrc] [clipVisionModelSrc]",
  );
  process.exit(1);
}

try {
  console.log("▸ Loading Wan 2.1 I2V model (diffusion + UMT5-XXL + VAE + CLIP vision)...");
  const modelId = await loadModel({
    modelSrc: diffusionModelSrc,
    modelType: "sdcpp-generation",
    modelConfig: {
      mode: "video",
      device: "gpu",
      threads: 4,
      t5XxlModelSrc,
      vaeModelSrc,
      clipVisionModelSrc,
      diffusion_fa: true,
      offload_to_cpu: true,
      vae_on_cpu: true,
      vae_tiling: true,
    },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });
  console.log(`▸ Model loaded: ${modelId}`);

  const init_image = new Uint8Array(fs.readFileSync(initImagePath));
  console.log(`▸ Generating video for: "${prompt}"`);

  const { progressStream, outputs, stats } = video({
    modelId,
    mode: "img2vid",
    prompt,
    init_image,
    negative_prompt: "blurry, distorted, low quality, jittery, static, frozen",
    strength: 0.85,
    flow_shift: 3.0,
    video_frames: 33,
    fps: 16,
    steps: 30,
    cfg_scale: 6.0,
    seed: 42,
    vae_tiling: true,
  });

  for await (const { step, totalSteps } of progressStream) {
    console.log(`▸ step ${step}/${totalSteps}`);
  }

  const buffers = await outputs;
  for (let i = 0; i < buffers.length; i++) {
    const outputPath = path.join(outputDir, `wan_i2v_${i}.avi`);
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
