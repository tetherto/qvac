'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const VideoStableDiffusion = require('../video')

const MODELS_DIR = path.resolve(__dirname, '../models/minimax-h3')
const OUTPUT_DIR = path.resolve(__dirname, '../output')

const files = {
  model: path.join(MODELS_DIR, process.env.H3_MODEL || 'minimax_h3_fl2va_pruned-Q4_K.gguf'),
  llm: path.join(MODELS_DIR, process.env.H3_LLM || 'qwen3vl_32b_minimax_h3-Q4_K_M.gguf'),
  vae: path.join(MODELS_DIR, 'vae/minimax_h3_video_vae_fp16.safetensors'),
  audioVae: path.join(MODELS_DIR, 'vae/minimax_h3_audio_vae_fp32.safetensors')
}

function requireFile(label, filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} not found: ${filePath}`)
}

async function main() {
  for (const [label, filePath] of Object.entries(files)) requireFile(`MiniMax-H3 ${label}`, filePath)
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  const config = {
    device: process.env.H3_DEVICE || 'gpu',
    diffusion_fa: true,
    offload_to_cpu: process.env.H3_OFFLOAD_TO_CPU !== '0',
    stream_layers: process.env.H3_STREAM_LAYERS === '1'
  }
  if (process.env.H3_BACKEND) config.backend = process.env.H3_BACKEND
  if (process.env.H3_PARAMS_BACKEND) config.params_backend = process.env.H3_PARAMS_BACKEND
  if (process.env.H3_MAX_VRAM) config.max_vram = process.env.H3_MAX_VRAM

  const model = new VideoStableDiffusion({
    files,
    config,
    opts: { stats: true },
    logger: console
  })

  try {
    await model.load()
    const response = await model.run({
      mode: 'txt2vid',
      prompt:
        process.env.PROMPT ||
        'Premium cinematic coffee commercial. A confident adult sits at a small café table at sunrise, slowly lifts one matte black coffee cup, takes a relaxed sip, and smiles. Warm golden rim light, drifting steam, realistic skin, natural hands, shallow depth of field, subtle slow camera push-in, restrained natural motion, polished live-action advertising, no dialogue, no text overlay.',
      negative_prompt:
        process.env.NEG_PROMPT ||
        'extra people, duplicate cup, malformed hands, cup fused to hand, text, subtitles, watermark, cartoon, CGI, blur, flicker, jitter, camera shake',
      width: Number(process.env.WIDTH || 960),
      height: Number(process.env.HEIGHT || 544),
      video_frames: Number(process.env.FRAMES || 124),
      fps: 24,
      steps: Number(process.env.STEPS || 8),
      cfg_scale: 1.0,
      guidance: Number(process.env.GUIDANCE || 7),
      seed: Number(process.env.SEED || 11)
    })

    let avi
    let stats
    response.on('stats', (value) => {
      stats = value
    })
    await response
      .onUpdate((data) => {
        if (data instanceof Uint8Array) avi = data
      })
      .await()

    if (!avi) throw new Error('Generation finished without an AVI result')
    const output = path.join(OUTPUT_DIR, process.env.OUTPUT || 'minimax-h3-coffee-commercial.avi')
    fs.writeFileSync(output, avi)
    console.log(`Saved ${output}`)
    if (stats) console.log(`Stats: ${stats.videoFrames} frames @ ${stats.fps} fps; audio=${stats.hasAudio}`)
  } finally {
    await model.unload()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
