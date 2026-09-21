import {
  loadModel,
  unloadModel,
  video,
  WAN2_2_TI2V_5B_Q5_K_S,
  UMT5_XXL_FP16,
  WAN_2_2_COMFYUI_REPACKAGED_VAE
} from '@qvac/sdk'
import fs from 'fs'
import path from 'path'

// Text-to-video with Wan 2.2 TI2V-5B Turbo (Q5_K_S). Like Wan 2.1 this is a
// split layout — diffusion model + UMT5-XXL text encoder + VAE — but it needs
// the Wan 2.2 VAE specifically: its 16x spatial compression is what gives
// TI2V its 32-pixel grid, and the Wan 2.1 VAE is not interchangeable.
//
// TI2V-5B is a single-expert model. The high_noise_* / moe_boundary fields
// belong to the two-expert Wan 2.2 A14B layout and are rejected here.
//
// Budget at least 16 GB of video memory or 20 GB of unified memory. The
// artifacts total roughly 16.4 GB, dominated by the fp16 text encoder.
//
// The text encoder is byte-identical to the Wan 2.1 repackage, so both
// generations share the one UMT5_XXL_FP16 registry entry.
const diffusionModelSrc = process.argv[2] || WAN2_2_TI2V_5B_Q5_K_S
const t5XxlModelSrc = process.argv[3] || UMT5_XXL_FP16
const vaeModelSrc = process.argv[4] || WAN_2_2_COMFYUI_REPACKAGED_VAE

// Prompt tip: Turbo responds well to explicit camera and lighting direction.
// Describe continuous motion rather than a pose, or the clip reads as a still.
const prompt =
  process.argv[5] ||
  'A single white porcelain espresso cup on a dark walnut table beside a sunlit window, ' +
    'delicate steam curling upward, slow circular camera move, warm morning light, ' +
    'sharp ceramic texture, realistic continuous motion'
const outputDir = process.argv[6] || '.'

try {
  console.log('▸ Loading Wan 2.2 TI2V-5B Turbo model (diffusion + UMT5-XXL + Wan 2.2 VAE)...')
  const modelId = await loadModel({
    modelSrc: diffusionModelSrc,
    modelType: 'sdcpp-generation',
    modelConfig: {
      mode: 'video',
      device: 'gpu',
      threads: 4,
      t5XxlModelSrc,
      vaeModelSrc,
      diffusion_fa: true,
      offload_to_cpu: true,
      vae_tiling: true
    },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })
  console.log(`▸ Model loaded: ${modelId}`)

  console.log(`\n▸ Generating video for: "${prompt}"`)

  const { progressStream, outputs, stats } = video({
    modelId,
    mode: 'txt2vid',
    prompt,
    negative_prompt:
      'flickering, temporal jitter, morphing, duplicated subject, warped geometry, ' +
      'distorted anatomy, blurry details, low resolution, text, watermark, logo',
    // TI2V-5B requires width and height to be multiples of 32 — stricter than
    // the multiple of 16 the schema enforces for Wan generally. Native
    // validation derives this from the loaded GGUF, so a non-conforming size
    // fails at generation time rather than at load.
    // Turbo was trained on this 720p, 24 fps, five-second shape; 640x352 with
    // 49 frames is a much cheaper way to smoke-test the pipeline.
    width: 1280,
    height: 704,
    // Frame count must satisfy (4*k + 1), k >= 1. At 24 fps: 49 ≈ 2s,
    // 121 ≈ 5s (the trained length).
    video_frames: 121,
    fps: 24,
    // Turbo is distilled for very short schedules: 4 steps with guidance
    // effectively disabled. The non-distilled TI2V-5B wants steps >= 30 and
    // cfg ~5.0 instead.
    steps: 4,
    cfg_scale: 1.0,
    flow_shift: 5.0,
    seed: 42,
    vae_tiling: true
  })

  for await (const { step, totalSteps } of progressStream) {
    console.log(`▸ step ${step}/${totalSteps}`)
  }

  const buffers = await outputs
  for (let i = 0; i < buffers.length; i++) {
    const outputPath = path.join(outputDir, `wan22_ti2v_t2v_${i}.avi`)
    fs.writeFileSync(outputPath, buffers[i]!)
    console.log(`▸ Saved ${outputPath}`)
  }

  console.log('\n▸ Stats:', await stats)
  await unloadModel({ modelId, clearStorage: false })
  console.log('▸ Done.')
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
