'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const VideoStableDiffusion = require('../video')

const MODELS_DIR = path.resolve(
  process.env.H3_MODELS_DIR || path.join(__dirname, '../models/minimax-h3-comfy-int8-convrot')
)
const OUTPUT_DIR = path.resolve(process.env.H3_OUTPUT_DIR || path.join(__dirname, '../output'))

function modelPath(envName, relativePath) {
  return path.resolve(MODELS_DIR, process.env[envName] || relativePath)
}

function imageDimensions(bytes) {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break
      const marker = bytes[offset + 1]
      if (marker === 0xda || marker === 0xd9) break
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
      if (length < 2 || offset + 2 + length > bytes.length) break
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)) {
        return {
          width: (bytes[offset + 7] << 8) | bytes[offset + 8],
          height: (bytes[offset + 5] << 8) | bytes[offset + 6]
        }
      }
      offset += 2 + length
    }
  }
  return null
}

function requireImage(imagePath, width, height) {
  if (!fs.existsSync(imagePath)) throw new Error(`Initial image not found: ${imagePath}`)
  const bytes = fs.readFileSync(imagePath)
  const dimensions = imageDimensions(bytes)
  if (!dimensions) throw new Error(`Initial image must be PNG or JPEG: ${imagePath}`)
  if (dimensions.width !== width || dimensions.height !== height) {
    throw new Error(
      `Initial image is ${dimensions.width}x${dimensions.height}; H3 request is ${width}x${height}. ` +
        'Generate or crop the image to the requested dimensions first.'
    )
  }
  return bytes
}

async function runH3Video({ mode, prompt, imagePath, outputPath }) {
  const width = Number(process.env.H3_WIDTH || 960)
  const height = Number(process.env.H3_HEIGHT || 544)
  const files = {
    model: modelPath(
      'H3_MODEL',
      'diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors'
    ),
    llm: modelPath('H3_LLM', 'text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors'),
    vae: modelPath('H3_VAE', 'vae/minimax_h3_video_vae_fp16.safetensors'),
    audioVae: modelPath('H3_AUDIO_VAE', 'vae/minimax_h3_audio_vae_fp32.safetensors')
  }
  for (const [name, filePath] of Object.entries(files)) {
    if (!fs.existsSync(filePath)) throw new Error(`Missing ${name}: ${filePath}`)
  }
  const initImage = mode === 'img2vid' ? requireImage(imagePath, width, height) : null
  const output = path.resolve(outputPath || path.join(OUTPUT_DIR, `minimax-h3-${mode}.avi`))
  fs.mkdirSync(path.dirname(output), { recursive: true })

  const config = {
    device: process.env.H3_DEVICE || 'gpu',
    diffusion_fa: true,
    offload_to_cpu: process.env.H3_OFFLOAD_TO_CPU === '1',
    params_backend: process.env.H3_PARAMS_BACKEND || 'diffusion=disk,te=disk,vae=disk'
  }
  if (process.env.H3_BACKEND) config.backend = process.env.H3_BACKEND
  if (process.env.H3_PARAMS_BACKEND) config.params_backend = process.env.H3_PARAMS_BACKEND

  const model = new VideoStableDiffusion({ files, config, opts: { stats: true }, logger: console })
  const onInterrupt = () => {
    void model.cancel().catch(console.error)
  }
  process.on('SIGINT', onInterrupt)
  try {
    await model.load()
    const params = {
      mode,
      prompt,
      negative_prompt:
        process.env.H3_NEGATIVE_PROMPT || 'blurry, flicker, distortion, subtitles, watermark',
      width,
      height,
      video_frames: Number(process.env.H3_FRAMES || 22),
      fps: 24,
      steps: Number(process.env.H3_STEPS || 8),
      cfg_scale: 1,
      vae_tiling: true,
      seed: Number(process.env.H3_SEED || 11)
    }
    if (initImage) params.init_image = initImage
    const response = await model.run(params)
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
    if (!avi) throw new Error('H3 completed without an AVI result')
    fs.writeFileSync(output, avi)
    console.log(`Saved ${output}`)
    if (stats)
      console.log(`Frames: ${stats.videoFrames}; fps: ${stats.fps}; audio: ${stats.hasAudio}`)
    return output
  } finally {
    process.off('SIGINT', onInterrupt)
    await model.unload()
  }
}

module.exports = { runH3Video, requireImage, imageDimensions, MODELS_DIR, OUTPUT_DIR }
