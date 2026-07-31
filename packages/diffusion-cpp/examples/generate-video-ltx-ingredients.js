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
  : path.resolve(__dirname, '../output/flux2-ingredients/reference-sheet-768x448-v2.png')
const loraPath = path.join(
  MODELS_DIR,
  process.env.INGREDIENTS_LORA || 'ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors'
)

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
    const percentage = (completed / total) * 100
    const fields = [
      `[ltx] step ${step}/${total}`,
      `${percentage.toFixed(1)}%`,
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
    opts: { stats: true },
    logger: console
  })

  try {
    await model.load()
    const generationStartedAt = Date.now()
    const logProgress = createProgressLogger(generationStartedAt)
    const response = await model.run({
      mode: 'txt2vid',
      prompt:
        process.env.PROMPT ||
        'Use the single reference sheet as four explicitly bound visual ingredients. The top-left portrait defines the exact same adult man, preserving his recognizable face, short dark hair, skin tone, and facial proportions. The top-center panel defines his complete outfit: the same plain dark forest-green hooded cloak over a black tunic and dark trousers, with realistic heavy woven fabric and no armor. The top-right panel defines exactly one complete Warglaive of Azzinoth: preserve its entire black-and-gold ornate handle and symmetrical curved emerald-green blades, with a restrained green glow. The wide bottom panel defines the golden wind-carved desert dune. Create one continuous cinematic hero shot of that man standing still on the crest-side of the same dune at sunset. Use a low-angle medium shot framed consistently from mid-thigh to above his head, never an extreme close-up: the man occupies the left-center half, his recognizable face is prominent and sharply resolved, his green hooded cloak and black clothing remain clearly visible, and the dune ridge and amber sky remain visible behind him. He holds the one complete warglaive at arm length in the right third of frame; fit the entire weapon from blade tips to pommel inside the frame with a clear air gap between the weapon and his face and body. A 50mm cinematic lens and shallow but controlled depth of field keep face, cloak, and weapon readable while the distant dune falls gently soft. Warm sunset rim light outlines his cheek and cloak. Realistic skin pores, individual hair, detailed green fabric weave, crisp engraved metal, natural color, filmic contrast. He remains poised and resolute, looking just past camera; only subtle breathing, a very slow controlled push-in that preserves the composition, gentle wind at the cloak hem, and a light veil of foreground dust. Deliberate restrained motion, realistic fantasy live-action, no dialogue, no music.',
      // CFG 1 is the known-good distilled-model setting, so the negative prompt
      // is mainly a guardrail; positive composition wording carries more weight.
      negative_prompt:
        process.env.NEG_PROMPT ||
        'low detail, soft focus, blur, smeared face, identity drift, deformed face, asymmetrical eyes, waxy skin, malformed hands, extra fingers, missing fingers, extra limbs, fused limbs, broken anatomy, duplicate person, duplicate weapon, two weapons, extra blade, missing blade, bent weapon, melted metal, weapon crossing face, weapon overlapping face, cropped weapon, cropped head, extreme close-up, macro portrait, distant full-body shot, missing cloak, missing dune, empty black background, running, fighting, excessive action, camera shake, jitter, flicker, inconsistent motion, oversaturated green glow, overexposure, blown highlights, flat lighting, cartoon, CGI, illustration, letterbox bars, border, frame, text, subtitle, caption, watermark, logo, brand mark, garbled text, UI',
      width: Number(process.env.WIDTH || 768),
      height: Number(process.env.HEIGHT || 448),
      video_frames: Number(process.env.FRAMES || 121),
      fps: Number(process.env.FPS || 24),
      steps: Number(process.env.STEPS || 8),
      scheduler: process.env.SCHEDULER || 'ltx2',
      cfg_scale: Number(process.env.CFG_SCALE || 1),
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
      ...(process.env.VAE_TILE_SIZE ? { vae_tile_size: Number(process.env.VAE_TILE_SIZE) } : {})
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
    const output = path.join(
      OUTPUT_DIR,
      process.env.OUTPUT || 'ltx-flux2-ingredients-warrior-v2.avi'
    )
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
