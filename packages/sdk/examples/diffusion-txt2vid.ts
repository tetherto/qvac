import {
  loadModel,
  unloadModel,
  video,
  WAN2_1_T2V_1_3B_FP16,
  UMT5_XXL_FP16,
  WAN_2_1_COMFYUI_REPACKAGED_VAE,
} from "@qvac/sdk";
import fs from "fs";
import path from "path";

// Text-to-video with Wan 2.1 T2V 1.3B. Wan uses a split layout:
// a diffusion model + a UMT5-XXL text encoder + a VAE.
// This example needs powerful hardware: at least 16 GB of video memory or
// 20 GB of unified memory.
const diffusionModelSrc = process.argv[2] || WAN2_1_T2V_1_3B_FP16;
const t5XxlModelSrc = process.argv[3] || UMT5_XXL_FP16;
const vaeModelSrc = process.argv[4] || WAN_2_1_COMFYUI_REPACKAGED_VAE;

// Prompt tip: Wan 1.3B is small and has weak temporal priors. Use motion-
// explicit verbs and avoid static framing words like "standing", "still",
// or "portrait" in the positive prompt.
const prompt = process.argv[5] || "a colorful bird flapping its wings";
const outputDir = process.argv[6] || ".";

try {
  console.log("Loading Wan 2.1 T2V model (diffusion + UMT5-XXL + VAE)...");
  const modelId = await loadModel({
    modelSrc: diffusionModelSrc,
    modelType: "sdcpp-generation",
    modelConfig: {
      mode: "video",
      device: "gpu",
      threads: 4,
      t5XxlModelSrc,
      vaeModelSrc,
      diffusion_fa: true,
      offload_to_cpu: true,
      vae_on_cpu: true,
      vae_tiling: true,
    },
    onProgress: (p) => console.log(`Loading: ${p.percentage.toFixed(1)}%`),
  });
  console.log(`Model loaded: ${modelId}`);

  console.log(`\nGenerating video for: "${prompt}"`);

  const { progressStream, outputs, stats } = video({
    modelId,
    mode: "txt2vid",
    prompt,
    negative_prompt: "blurry, low quality, static, jittery, watermark",
    width: 480,
    height: 832,
    // Frame count must satisfy (4*k + 1), k >= 1. Common values at 16 fps:
    // 17 frames ~= 1.06s (very fast, ~6 min on M3 Ultra Metal)
    // 33 frames ~= 2.06s (default in this example, ~11 min)
    // 49 frames ~= 3.06s (~17 min)
    // 65 frames ~= 4.06s (~22 min)
    // 81 frames ~= 5.06s (Wan 1.3B native training length, best motion
    // quality, ~28 min)
    // Going beyond 81 can degrade quality because it exceeds the model's
    // positional embeddings.
    video_frames: 33,
    fps: 16,
    steps: 30,
    cfg_scale: 6.0,
    // Wan 2.1 T2V needs flow_shift=3.0 for visible motion. Higher values can
    // make consecutive frames near-identical, which looks like a frozen video.
    flow_shift: 3.0,
    seed: 42,
    vae_tiling: true,
  });

  for await (const { step, totalSteps } of progressStream) {
    process.stdout.write(`\rStep ${step}/${totalSteps}`);
  }
  console.log();

  const buffers = await outputs;
  for (let i = 0; i < buffers.length; i++) {
    const outputPath = path.join(outputDir, `wan_t2v_${i}.avi`);
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
