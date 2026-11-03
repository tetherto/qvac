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

// Text-to-video (+ synchronized audio) with LTX-2. Unlike Wan, LTX-2 uses a
// Gemma text encoder (llmModelSrc), a video VAE (vaeModelSrc), a set of
// text-embedding connectors (embeddingsConnectorsModelSrc — this is what
// selects the LTX-2 layout), and an optional audio VAE (audioVaeModelSrc)
// that produces a 48 kHz audio track muxed into the output AVI.
//
// This example needs powerful hardware: LTX-2.3 is a ~21B model, budget at
// least 20+ GB of video / unified memory.
//
// Pass your own paths / URLs via argv to override any of the five sources.
const diffusionModelSrc = process.argv[2] || LTX_2_3_22B_Q5_K_M
const llmModelSrc = process.argv[3] || GEMMA_3_12B_Q4_K_XL
const vaeModelSrc = process.argv[4] || LTX_2_3_VIDEO_VAE
const audioVaeModelSrc = process.argv[5] || LTX_2_3_AUDIO_VAE
const embeddingsConnectorsModelSrc = process.argv[6] || LTX_2_3_22B_DISTILLED_EMBEDDINGS_CONNECTORS

const prompt = process.argv[7] || 'a claymation cat playing jazz on a piano'
const outputDir = process.argv[8] || '.'

try {
  console.log('▸ Loading LTX-2 model (diffusion + Gemma + video VAE + audio VAE + connectors)...')
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

  console.log(`\n▸ Generating video for: "${prompt}"`)

  const { progressStream, outputs, stats } = video({
    modelId,
    mode: 'txt2vid',
    prompt,
    negative_prompt: 'blurry, low quality, static, jittery, watermark, distorted audio',
    // LTX-2 requires width/height as multiples of 32.
    width: 512,
    height: 320,
    // LTX-2 requires (8*k + 1) frames, max 257. At 24 fps: 25≈1s, 121≈5s, 241≈10s.
    video_frames: 121,
    fps: 24,
    // Distilled variants run in 4-8 steps with cfg ~1.0; the full --dev model
    // wants steps >= 20 and cfg ~7.0.
    steps: 10,
    cfg_scale: 1.0,
    seed: 42,
    // Tile the video VAE decode along the time axis to cap peak VRAM on long
    // / HD clips (LTX-2 only).
    temporal_tiling: true
  })

  for await (const { step, totalSteps } of progressStream) {
    console.log(`▸ step ${step}/${totalSteps}`)
  }

  const buffers = await outputs
  for (let i = 0; i < buffers.length; i++) {
    const outputPath = path.join(outputDir, `ltx_t2v_${i}.avi`)
    fs.writeFileSync(outputPath, buffers[i]!)
    console.log(`▸ Saved ${outputPath} (play in VLC to hear the muxed audio track)`)
  }

  console.log('\n▸ Stats:', await stats)
  await unloadModel({ modelId, clearStorage: false })
  console.log('▸ Done.')
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
