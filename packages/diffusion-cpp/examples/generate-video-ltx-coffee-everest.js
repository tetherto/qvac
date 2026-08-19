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
  model: path.join(MODELS_DIR, process.env.LTX_MODEL || 'LTX-2.3-22B-distilled-1.1-Q8_0.gguf'),
  llm: path.join(MODELS_DIR, process.env.LTX_LLM || 'gemma-3-12b-it-UD-Q4_K_XL.gguf'),
  vae: path.join(MODELS_DIR, process.env.LTX_VAE || 'ltx-2.3-22b-distilled_video_vae.safetensors'),
  audioVae: path.join(
    MODELS_DIR,
    process.env.LTX_AUDIO_VAE || 'ltx-2.3-22b-distilled_audio_vae.safetensors'
  ),
  embeddingsConnectors: path.join(
    MODELS_DIR,
    process.env.LTX_CONNECTORS || 'ltx-2.3-22b-distilled_embeddings_connectors.safetensors'
  )
}

const referencePath = process.env.REFERENCE_SHEET
  ? path.resolve(process.env.REFERENCE_SHEET)
  : path.resolve(__dirname, '../assets/ltx-coffee-everest-reference-sheet-768x448.png')
const loraPath = path.join(
  MODELS_DIR,
  process.env.INGREDIENTS_LORA || 'ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors'
)

const PROMPT =
  'Use every panel in the reference sheet as an explicitly bound ingredient. The top-left panel defines the exact same adult man with black hair and green eyes. The top-middle panel defines his complete modern scientist outfit: light-grey laboratory coat over a charcoal shirt with dark trousers. The top-right panel defines exactly one matte-black branded Tether Coffee paper cup with visible steam. The bottom-left panel defines the pale birchwood table and single matching chair. The bottom-right panel defines the high Mount Everest landscape above a sea of clouds. Create one continuous cinematic live-action medium shot: the same scientist sits naturally in the birchwood chair at the birchwood table on a safe snowy overlook high above the clouds, with Mount Everest clearly visible behind him at sunrise. He holds the one Tether Coffee cup, slowly raises it to his lips, takes one calm sip, then lowers it slightly as steam curls in the cold air. Preserve his recognizable face, green eyes, black hair, scientist clothing, furniture, cup, and mountain environment. Warm sunrise rim light, subtle wind moving his coat, realistic skin and fabric, natural restrained motion, shallow controlled depth of field, stable camera with a very slow push-in, premium cinematic expedition commercial, no dialogue, no music.'
const NEGATIVE_PROMPT =
  'identity drift, different person, missing lab coat, missing table, missing chair, missing coffee cup, duplicate cup, extra person, extra furniture, malformed hands, cup fused to hand, drinking through lid, garbled text, duplicate mountain, indoor room, cartoon, CGI, blur, soft focus, camera shake, jitter, flicker, overexposure, text overlay, subtitles, watermark'

function envFlag(name, defaultValue) {
  const value = process.env[name]
  if (value === undefined) return defaultValue
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase())
}

function mainGpuFromEnv() {
  const value = process.env.LTX_MAIN_GPU
  if (value === undefined || value === '') return undefined
  if (value === 'integrated' || value === 'dedicated') return value

  const index = Number(value)
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('LTX_MAIN_GPU must be a non-negative index, integrated, or dedicated')
  }
  return index
}

function requireFile(label, filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`)
  }
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`

  const seconds = milliseconds / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`

  const roundedSeconds = Math.round(seconds)
  const minutes = Math.floor(roundedSeconds / 60)
  return `${minutes}m ${String(roundedSeconds % 60).padStart(2, '0')}s`
}

function createProgressLogger(startedAt) {
  let sequenceStartElapsedMs = null
  let lastStep = null
  let lastTotal = null
  let lastElapsedMs = null

  return (data) => {
    if (typeof data !== 'string') return

    let tick
    try {
      tick = JSON.parse(data)
    } catch {
      return
    }

    if (!tick || typeof tick !== 'object' || Array.isArray(tick)) return

    const { step, total } = tick
    if (!Number.isInteger(step) || step < 0 || !Number.isInteger(total) || total <= 0) {
      return
    }

    const reportedElapsedMs = tick.elapsed_ms
    const elapsedMs =
      typeof reportedElapsedMs === 'number' &&
      Number.isFinite(reportedElapsedMs) &&
      reportedElapsedMs >= 0
        ? reportedElapsedMs
        : Date.now() - startedAt
    const startsSequence = lastStep === null || step < lastStep || total !== lastTotal

    if (startsSequence) {
      sequenceStartElapsedMs = step === 0 ? elapsedMs : null
      lastElapsedMs = null
    }

    const stepDurationMs =
      lastElapsedMs !== null && step > lastStep ? elapsedMs - lastElapsedMs : null
    const completed = Math.min(step, total)
    const fields = [
      `[ltx] step ${step}/${total}`,
      `${((completed / total) * 100).toFixed(1)}%`,
      `elapsed ${formatDuration(elapsedMs)}`
    ]

    if (stepDurationMs !== null && stepDurationMs >= 0) {
      fields.push(`step time ${formatDuration(stepDurationMs)}`)
    }

    if (step > 0 && step < total) {
      const measuredMs =
        sequenceStartElapsedMs === null ? elapsedMs : elapsedMs - sequenceStartElapsedMs
      const etaMs = (measuredMs / step) * (total - step)
      if (Number.isFinite(etaMs) && etaMs >= 0) {
        fields.push(`ETA ${formatDuration(etaMs)}`)
      }
    }

    console.log(fields.join(' | '))
    lastStep = step
    lastTotal = total
    lastElapsedMs = elapsedMs
  }
}

async function main() {
  for (const [name, filePath] of Object.entries(files)) {
    requireFile(`LTX ${name}`, filePath)
  }
  requireFile('Reference sheet', referencePath)
  requireFile(
    'Ingredients LoRA (run HF_TOKEN=hf_... ./scripts/download-model-ltx-ingredients.sh)',
    loraPath
  )

  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  const reference = fs.readFileSync(referencePath)

  setLogger((priority, message) => {
    const label = NATIVE_LOG_LABELS[priority] || String(priority)
    process.stderr.write(`[sd:${label}] ${message}`)
  })

  const model = new VideoStableDiffusion({
    files,
    config: {
      threads: 4,
      device: process.env.LTX_DEVICE || 'gpu',
      'main-gpu': mainGpuFromEnv(),
      diffusion_fa: envFlag('DIFFUSION_FA', true),
      diffusion_conv_direct: envFlag('DIFFUSION_CONV_DIRECT', true),
      // LTX-2.3 plus Gemma and the VAE exceed a 32 GB card. Keep parameters in
      // system RAM by default so Vulkan has headroom for generation buffers.
      offload_to_cpu: envFlag('LTX_OFFLOAD_TO_CPU', true),
      // An explicit CPU override remains available. Otherwise preflight each
      // VAE graph and route only oversized graphs to CPU; DiT remains on Vulkan.
      vae_on_cpu: envFlag('LTX_VAE_ON_CPU', false),
      vae_auto_cpu_fallback: envFlag('LTX_VAE_AUTO_CPU_FALLBACK', true),
      vae_auto_cpu_fallback_memory_ratio: Number(
        process.env.LTX_VAE_AUTO_CPU_FALLBACK_MEMORY_RATIO || 0.9
      ),
      vae_tiling: true,
      vae_conv_direct: envFlag('VAE_CONV_DIRECT', true),
      lora_apply_mode: 'at_runtime',
      verbosity: Number(process.env.VERBOSITY || 2)
    },
    opts: { stats: true },
    logger: console
  })

  try {
    await model.load()
    const generationStartedAt = Date.now()
    const logProgress = createProgressLogger(generationStartedAt)
    const response = await model.run({
      mode: 'txt2vid',
      prompt: process.env.PROMPT || PROMPT,
      negative_prompt: process.env.NEG_PROMPT || NEGATIVE_PROMPT,
      width: Number(process.env.WIDTH || 768),
      height: Number(process.env.HEIGHT || 448),
      video_frames: Number(process.env.FRAMES || 217),
      fps: Number(process.env.FPS || 24),
      steps: Number(process.env.STEPS || 8),
      scheduler: process.env.SCHEDULER || 'ltx2',
      cfg_scale: Number(process.env.CFG_SCALE || 1),
      seed: Number(process.env.SEED || 84),
      lora: loraPath,
      lora_strength: Number(process.env.LORA_STRENGTH || 1.37),
      stg_scale: Number(process.env.STG_SCALE || 1),
      stg_block: Number(process.env.STG_BLOCK || 29),
      reference_images: [reference],
      reference_attention_strength: 1,
      reference_downscale_factor: 1,
      temporal_tiling: true,
      vae_tile_size: Number(process.env.VAE_TILE_SIZE || 4),
      vae_extra_tiling_args: process.env.VAE_EXTRA_TILING_ARGS
    })

    let avi
    let stats
    response.on('stats', (value) => {
      stats = value
    })
    await response
      .onUpdate((data) => {
        if (data instanceof Uint8Array) {
          avi = data
        } else {
          logProgress(data)
        }
      })
      .await()

    if (!avi) throw new Error('Generation finished without an AVI result')
    const output = path.join(OUTPUT_DIR, process.env.OUTPUT || 'ltx-coffee-everest-9s.avi')
    fs.writeFileSync(output, avi)
    console.log(`Saved ${output}`)
    if (stats) {
      console.log(
        `Stats: ${stats.videoFrames} frames @ ${stats.fps} fps, ` +
          `generation ${formatDuration(stats.generationMs)}`
      )
    }
  } finally {
    await model.unload()
    releaseLogger()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
