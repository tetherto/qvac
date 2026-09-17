import {
  GEMMA_3_12B_Q4_K_XL,
  loadModel,
  LTX_2_3_22B_DISTILLED_EMBEDDINGS_CONNECTORS,
  LTX_2_3_22B_Q5_K_M,
  LTX_2_3_AUDIO_VAE,
  LTX_2_3_VIDEO_VAE,
  unloadModel,
  video
} from '@qvac/sdk'
import fs from 'fs'
import path from 'path'

const loraPath = process.argv[2]
const referencePath = process.argv[3]
const prompt =
  process.argv[4] ||
  'Reference sheet: a red-haired explorer in a blue parka. Generated video: the explorer crosses a snowy ridge at sunrise.'
const outputDir = process.argv[5] || '.'

if (!loraPath || !referencePath) {
  console.error(
    'Usage: bare:example examples/diffusion-ic-lora-ltx.ts <absolute-lora-path> <reference-sheet-path> [prompt] [output-dir]'
  )
  process.exit(1)
}
if (!path.isAbsolute(loraPath)) {
  console.error('The LoRA adapter path must be absolute on the inference worker.')
  process.exit(1)
}

const referenceSheet = fs.readFileSync(referencePath)

try {
  const modelId = await loadModel({
    modelSrc: LTX_2_3_22B_Q5_K_M,
    modelType: 'sdcpp-generation',
    modelConfig: {
      mode: 'video',
      device: 'gpu',
      threads: 4,
      llmModelSrc: GEMMA_3_12B_Q4_K_XL,
      vaeModelSrc: LTX_2_3_VIDEO_VAE,
      audioVaeModelSrc: LTX_2_3_AUDIO_VAE,
      embeddingsConnectorsModelSrc: LTX_2_3_22B_DISTILLED_EMBEDDINGS_CONNECTORS,
      diffusion_fa: true,
      offload_to_cpu: true,
      vae_tiling: true,
      lora_apply_mode: 'at_runtime'
    }
  })

  const { progressStream, outputs, stats } = video({
    modelId,
    mode: 'txt2vid',
    prompt,
    negative_prompt: 'blurry, low quality, static, jittery, watermark',
    width: 768,
    height: 448,
    video_frames: 217,
    fps: 24,
    steps: 8,
    scheduler: 'ltx2',
    cfg_scale: 1,
    seed: 84,
    lora: loraPath,
    lora_strength: 1.37,
    stg_scale: 1,
    stg_block: 29,
    reference_images: [referenceSheet],
    reference_attention_strength: 1,
    reference_downscale_factor: 1,
    temporal_tiling: true,
    vae_tile_size: 4
  })

  for await (const { step, totalSteps } of progressStream) {
    console.log(`▸ step ${step}/${totalSteps}`)
  }

  fs.mkdirSync(outputDir, { recursive: true })
  const buffers = await outputs
  for (let i = 0; i < buffers.length; i++) {
    const outputPath = path.join(outputDir, `ltx_ic_lora_${i}.avi`)
    fs.writeFileSync(outputPath, buffers[i]!)
    console.log(`▸ Saved ${outputPath}`)
  }

  console.log('▸ Stats:', await stats)
  await unloadModel({ modelId, clearStorage: false })
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
