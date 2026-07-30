'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const VideoStableDiffusion = require('../video')
const { setLogger, releaseLogger } = require('../addonLogging')

const NATIVE_LOG_LABELS = ['ERROR', 'WARN', 'INFO', 'DEBUG']

const MODELS_DIR = path.resolve(__dirname, '../models')
const OUTPUT_DIR = path.resolve(__dirname, '../output')

const files = {
  model: path.join(MODELS_DIR, process.env.LTX_MODEL || 'LTX-2.3-dev-Q2_K.gguf'),
  llm: path.join(MODELS_DIR, process.env.LTX_LLM || 'gemma-3-12b-it-UD-Q2_K_XL.gguf'),
  vae: path.join(MODELS_DIR, process.env.LTX_VAE || 'ltx-2.3-22b-dev_video_vae.safetensors'),
  audioVae: path.join(MODELS_DIR, process.env.LTX_AUDIO_VAE || 'ltx-2.3-22b-dev_audio_vae.safetensors'),
  embeddingsConnectors: path.join(
    MODELS_DIR,
    process.env.LTX_CONNECTORS || 'ltx-2.3-22b-dev_embeddings_connectors.safetensors'
  )
}

const referencePath = path.join(
  MODELS_DIR,
  process.env.REFERENCE_SHEET || 'ltx-ingredients-reference-sheet-768x448.png'
)
const loraPath = path.join(
  MODELS_DIR,
  process.env.INGREDIENTS_LORA || 'ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors'
)

async function main () {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  const reference = fs.readFileSync(referencePath)

  // Without this the native sd_log_callback has no JS sink and every engine
  // message (including allocation failures) is discarded inside JsLogger::log.
  setLogger((priority, message) => {
    const label = NATIVE_LOG_LABELS[priority] || String(priority)
    process.stderr.write(`[sd:${label}] ${message}`)
  })

  const model = new VideoStableDiffusion({
    files,
    config: {
      threads: 4,
      device: 'gpu',
      diffusion_fa: true,
      vae_tiling: true,
      vae_conv_direct: true,
      lora_apply_mode: 'at_runtime',
      verbosity: Number(process.env.VERBOSITY || 2)
    },
    logger: console
  })

  try {
    await model.load()
    const response = await model.run({
      mode: 'txt2vid',
      prompt: process.env.PROMPT ||
        'Reference sheet: a smiling woman, a grey horse, and a misty mountain valley. Generated video: the woman walks beside the grey horse through the misty mountain valley, cinematic natural light.',
      negative_prompt: process.env.NEG_PROMPT ||
        'worst quality, inconsistent motion, blurry, jittery, distorted',
      width: Number(process.env.WIDTH || 768),
      height: Number(process.env.HEIGHT || 448),
      video_frames: Number(process.env.FRAMES || 121),
      fps: Number(process.env.FPS || 24),
      steps: Number(process.env.STEPS || 30),
      cfg_scale: Number(process.env.CFG_SCALE || 4),
      seed: Number(process.env.SEED || 42),
      lora: loraPath,
      lora_strength: Number(process.env.LORA_STRENGTH || 1.4),
      stg_scale: Number(process.env.STG_SCALE || 1),
      stg_block: Number(process.env.STG_BLOCK || 29),
      reference_images: [reference],
      reference_attention_strength: 1,
      reference_downscale_factor: 1,
      temporal_tiling: true,
      // The engine consumes vae_tile_size in LATENT units, so useful values for
      // the LTX VAE (spatial factor 32) are small, e.g. 16 -> 512 px tiles.
      ...(process.env.VAE_TILE_SIZE
        ? { vae_tile_size: Number(process.env.VAE_TILE_SIZE) }
        : {})
    })

    let avi
    await response
      .onUpdate((data) => {
        if (data instanceof Uint8Array) avi = data
      })
      .await()

    if (!avi) throw new Error('Generation finished without an AVI result')
    const output = path.join(
      OUTPUT_DIR,
      process.env.OUTPUT || 'ltx-ingredients-sample.avi'
    )
    fs.writeFileSync(output, avi)
    console.log(`Saved ${output}`)
  } finally {
    await model.unload()
    releaseLogger()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
