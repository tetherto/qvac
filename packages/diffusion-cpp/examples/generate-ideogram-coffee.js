'use strict'

// Ideogram 4 — photoreal lifestyle example ("coffee"): a smiling woman sitting
// at an outdoor cafe holding a bright yellow coffee cup.
//
// Demonstrates that photoreal humans render reliably when the structured caption
// carries an explicit bbox layout, which strongly reduces the model's false
// "safety filter" placeholder. Runs the caption verbatim (V1) plus an enriched
// variant (V2) across several seeds.
//
// Run: SEEDS=42,7,123 SIZE=768 STEPS=16 bare examples/generate-ideogram-coffee.js

const path = require('bare-path')
const process = require('bare-process')
const fs = require('bare-fs')
const ImgStableDiffusion = require('../index')

const MODELS_DIR = path.resolve(__dirname, '../models')
const OUT = path.resolve(__dirname, '../output/ideogram-woman')
const FILES = {
  model: path.join(MODELS_DIR, 'ideogram4-Q4_0.gguf'),
  uncondModel: path.join(MODELS_DIR, 'ideogram4_uncond-Q4_0.gguf'),
  llm: path.join(MODELS_DIR, 'Qwen3-VL-8B-Instruct-Q4_K_M.gguf'),
  vae: path.join(MODELS_DIR, 'flux2-vae.safetensors')
}
const SIZE = Number(process.env.SIZE || 768)
const STEPS = Number(process.env.STEPS || 16)
const CFG = Number(process.env.CFG || 7)
const SEEDS = (process.env.SEEDS || '42,7,123,999,11,22,33,44').split(',').map((s) => Number(s.trim()))

// V1 — the user's exact caption, verbatim.
const exact = {
  high_level_description: 'A lifestyle photograph of a smiling woman sitting at an outdoor cafe holding a bright yellow coffee cup.',
  style_description: {
    aesthetics: 'lifestyle photography, bright, airy, authentic, candid',
    lighting: 'golden hour sunlight, back-lit hair, warm glowing atmosphere',
    color_palette: ['#FFD700', '#FFFFFF', '#87CEEB']
  },
  compositional_deconstruction: {
    background: 'A slightly blurred Parisian cafe patio with wrought-iron chairs and green ivy.',
    elements: [
      { type: 'obj', bbox: [200, 100, 900, 800], desc: 'A young woman with curly auburn hair and freckles. She is laughing naturally and wearing a light blue denim jacket over a white sundress.' },
      { type: 'obj', bbox: [500, 400, 700, 600], desc: "A bright matte-yellow ceramic coffee mug being held by the woman's hands." }
    ]
  }
}

// V2 — enriched: adds photo/medium style fields, a third grounding element,
// canvas note, and tightens the framing. Same subject, stronger conditioning.
const rich = {
  high_level_description: 'A candid golden-hour lifestyle photograph of exactly one smiling young woman sitting at an outdoor Parisian cafe, holding a bright yellow coffee cup in both hands.',
  style_description: {
    aesthetics: 'lifestyle photography, bright, airy, authentic, candid, editorial',
    lighting: 'warm golden-hour backlight, glowing rim light on the hair, soft natural fill on the face',
    photo: '85mm portrait lens, shallow depth of field, natural realistic skin tones, crisp focus on the face, softly blurred background bokeh',
    medium: 'high-resolution photograph',
    color_palette: ['#FFD700', '#FFFFFF', '#87CEEB', '#3B2F2F', '#6B8E23']
  },
  compositional_deconstruction: {
    canvas: 'Square canvas, upright orientation, natural candid framing, no rotation.',
    background: 'A softly blurred Parisian cafe patio with wrought-iron chairs and lush green ivy melting into warm golden bokeh.',
    elements: [
      { type: 'obj', bbox: [210, 90, 880, 860], desc: 'Exactly one young woman with curly auburn hair and light freckles, laughing naturally, wearing a light-blue denim jacket over a white sundress. Realistic detailed face, natural expression, catchlights in the eyes.' },
      { type: 'obj', bbox: [430, 430, 690, 660], desc: "A bright matte-yellow ceramic coffee mug held in the woman's hands, steam rising gently." },
      { type: 'obj', bbox: [80, 640, 940, 990], desc: 'A small round marble cafe table in the soft-focus foreground with a folded napkin and a tiny saucer.' }
    ]
  }
}

const VARIANTS = [
  { tag: 'exact', prompt: JSON.stringify(exact) },
  { tag: 'rich', prompt: JSON.stringify(rich) }
]

async function main () {
  fs.mkdirSync(OUT, { recursive: true })
  const manifest = path.join(OUT, 'manifest.jsonl')
  fs.writeFileSync(manifest, '')
  console.log(`Woman experiment — ${SIZE}x${SIZE}, ${STEPS} steps, cfg ${CFG}, seeds ${SEEDS.join(',')}\n`)
  const model = new ImgStableDiffusion({
    files: FILES,
    config: { threads: 4, diffusion_fa: true, offload_to_cpu: true },
    logger: { info () {}, warn () {}, error (...a) { console.error(...a) }, debug () {} }
  })
  try {
    await model.load()
    console.log('Model loaded\n')
    let i = 0
    const total = VARIANTS.length * SEEDS.length
    for (const v of VARIANTS) {
      for (const seed of SEEDS) {
        i++
        const t = Date.now()
        let bytes = null
        try {
          const response = await model.run({ prompt: v.prompt, steps: STEPS, width: SIZE, height: SIZE, cfg_scale: CFG, seed })
          await response.onUpdate((d) => { if (d instanceof Uint8Array) bytes = d }).await()
        } catch (err) { console.error(`  ${v.tag} s${seed} ERROR: ${err.message || err}`) }
        const ms = Date.now() - t
        let file = null
        if (bytes) { file = path.join(OUT, `woman_${v.tag}_s${seed}.png`); fs.writeFileSync(file, bytes) }
        fs.appendFileSync(manifest, JSON.stringify({ category: 'woman', subject: `woman ${v.tag}`, keyword: `woman-${v.tag}`, seed, file, ms }) + '\n')
        console.log(`[${i}/${total}] woman ${v.tag} s${seed} — ${(ms / 1000).toFixed(0)}s ${bytes ? `${(bytes.length / 1024).toFixed(0)}K` : 'NO BYTES'}`)
      }
    }
    console.log(`\nDone → ${manifest}`)
  } finally {
    await model.unload()
  }
}

main().catch((err) => { console.error('Fatal:', err.message || err); process.exit(1) })
