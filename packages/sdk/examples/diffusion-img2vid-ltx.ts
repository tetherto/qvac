import { loadModel, unloadModel, video } from '@qvac/sdk'
import fs from 'fs'
import path from 'path'

// Image-to-video (+ synchronized audio) with LTX-2. Unlike Wan I2V, LTX-2
// conditions on the first frame through its video VAE, so it needs NO CLIP
// vision weights (clipVisionModelSrc) — the same LTX-2 layout used for
// txt2vid works for img2vid, you just add an init_image at generation time.
//
// This example needs powerful hardware: LTX-2.3 is a ~21B model, budget at
// least 20+ GB of video / unified memory.
//
// No LTX-2 model constants ship in the SDK registry, so the model sources
// default to public HuggingFace URLs (the SDK downloads http(s) sources
// directly). Pass your own paths / URLs via argv to override.
const HF = 'https://huggingface.co'
const initImagePath = process.argv[2]
const prompt =
  process.argv[3] || 'the subject slowly turns and smiles, soft natural lighting, cinematic'
const outputDir = process.argv[4] || '.'
const diffusionModelSrc =
  process.argv[5] ||
  `${HF}/QuantStack/LTX-2.3-GGUF/resolve/main/LTX-2.3-distilled-1.1/LTX-2.3-22B-distilled-1.1-Q5_K_M.gguf`
const llmModelSrc =
  process.argv[6] || `${HF}/unsloth/gemma-3-12b-it-GGUF/resolve/main/gemma-3-12b-it-UD-Q4_K_XL.gguf`
const vaeModelSrc =
  process.argv[7] ||
  `${HF}/unsloth/LTX-2.3-GGUF/resolve/main/vae/ltx-2.3-22b-distilled_video_vae.safetensors`
const audioVaeModelSrc =
  process.argv[8] ||
  `${HF}/unsloth/LTX-2.3-GGUF/resolve/main/vae/ltx-2.3-22b-distilled_audio_vae.safetensors`
const embeddingsConnectorsModelSrc =
  process.argv[9] ||
  `${HF}/unsloth/LTX-2.3-GGUF/resolve/main/text_encoders/ltx-2.3-22b-distilled_embeddings_connectors.safetensors`

if (!initImagePath) {
  console.error('✖ init image path is required')
  console.error(
    'Usage: bun run bare:example dist/examples/diffusion-img2vid-ltx.js ' +
      '<initImagePath> [prompt] [outputDir] ' +
      '[diffusionModelSrc] [llmModelSrc] [vaeModelSrc] [audioVaeModelSrc] [embeddingsConnectorsModelSrc]'
  )
  process.exit(1)
}

try {
  console.log('▸ Loading LTX-2 model (diffusion + Gemma + video VAE + audio VAE + connectors)...')
  // no clipVisionModelSrc — LTX-2 img2vid does not use CLIP vision.
  const modelId = await loadModel({
    modelSrc: diffusionModelSrc,
    modelType: 'sdcpp-generation',
    modelConfig: {
      mode: 'video',
      device: 'gpu',
      threads: 4,
      // Supplying embeddingsConnectorsModelSrc selects the LTX-2 layout.
      llmModelSrc,
      vaeModelSrc,
      audioVaeModelSrc,
      embeddingsConnectorsModelSrc,
      diffusion_fa: true,
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

  const init_image = new Uint8Array(fs.readFileSync(initImagePath))
  console.log(`▸ Generating video for: "${prompt}"`)

  const { progressStream, outputs, stats } = video({
    modelId,
    mode: 'img2vid',
    prompt,
    init_image,
    negative_prompt: 'blurry, distorted, low quality, jittery, static, frozen, distorted audio',
    strength: 0.85,
    // LTX-2 requires width/height as multiples of 32 and (8*k + 1) frames (max 257).
    width: 512,
    height: 320,
    video_frames: 121,
    fps: 24,
    steps: 10,
    cfg_scale: 1.0,
    seed: 42,
    temporal_tiling: true
  })

  for await (const { step, totalSteps } of progressStream) {
    console.log(`▸ step ${step}/${totalSteps}`)
  }

  const buffers = await outputs
  for (let i = 0; i < buffers.length; i++) {
    const outputPath = path.join(outputDir, `ltx_i2v_${i}.avi`)
    fs.writeFileSync(outputPath, buffers[i]!)
    console.log(`▸ Saved ${outputPath} (play in VLC to hear the muxed audio track)`)
  }

  console.log('▸ Stats:', await stats)
  await unloadModel({ modelId, clearStorage: false })
  console.log('▸ Done')
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
