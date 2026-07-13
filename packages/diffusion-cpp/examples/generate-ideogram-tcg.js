'use strict'

// Ideogram 4 — original card game "Corporation".
//
// A deliberately original card frame (NOT based on any existing TCG's trade
// dress): a thick black border with a gold Greek meander (meandros / Greek-key)
// accent, a category-colored inner frame, a title banner, a salary-cost badge,
// an art window, a colored type band, an effect box, a flavor line, and custom
// stat labels.
//
// Categories (by color):
//   red   = Manager   · blue = Item · green = Employee
//
// Recipe: rich structured caption + explicit bbox layout (0-1000 canvas, bbox
// order [y0, x0, y1, x1] = top, left, bottom, right). 40 steps by default since
// it renders in-card text more legibly.
//
// Run:  bare examples/generate-ideogram-tcg.js            (default: Coffee Machine only)
//       bare examples/generate-ideogram-tcg.js --help     (list all cards + options)
//       ONLY=all SEEDS=42,7 bare examples/generate-ideogram-tcg.js   (whole set)
//       ONLY=product-manager,engineer bare examples/generate-ideogram-tcg.js

const path = require('bare-path')
const process = require('bare-process')
const fs = require('bare-fs')
const ImgStableDiffusion = require('../index')

const MODELS_DIR = path.resolve(__dirname, '../models')
const OUT = path.resolve(__dirname, '../output/ideogram-corporation')
const FILES = {
  model: path.join(MODELS_DIR, 'ideogram4-Q4_0.gguf'),
  uncondModel: path.join(MODELS_DIR, 'ideogram4_uncond-Q4_0.gguf'),
  llm: path.join(MODELS_DIR, 'Qwen3-VL-8B-Instruct-Q4_K_M.gguf'),
  vae: path.join(MODELS_DIR, 'flux2-vae.safetensors')
}
const SIZE = Number(process.env.SIZE || 768)
const STEPS = Number(process.env.STEPS || 40)
const CFG = Number(process.env.CFG || 7)
const SEEDS = (process.env.SEEDS || '42').split(',').map((s) => Number(s.trim()))
// Default run generates just the Coffee Machine card (seed 42, the known-good
// roll). Use ONLY=<ids> to pick specific cards, or ONLY=all for the whole set.
const ONLY = (process.env.ONLY || 'coffee-machine').split(',').map((s) => s.trim()).filter(Boolean)

// Per-category color themes. Frame color carries the category; black border and
// gold meandros accent are shared across all cards for a consistent set.
const THEMES = {
  manager: { label: 'MANAGER', frame: 'bright red', palette: ['#E63946', '#111111', '#F4C430', '#FFF8E7', '#7A0C10'] },
  item: { label: 'ITEM', frame: 'bright blue', palette: ['#1D8FE1', '#111111', '#F4C430', '#FFF8E7', '#0B3D6B'] },
  employee: { label: 'EMPLOYEE', frame: 'bright green', palette: ['#2FBF71', '#111111', '#F4C430', '#FFF8E7', '#0F5132'] }
}

function card ({ title, category, cost, art, typeLine, effect, flavor, stats }) {
  const theme = THEMES[category]
  return JSON.stringify({
    high_level_description: `A glossy original comedic corporate-themed trading card game card titled "${title}" from the game "CORPORATION". Bright playful cartoon style. The card has a thick glossy black outer border decorated with a gold Greek meander (meandros / Greek-key) pattern, and a ${theme.frame} inner frame denoting a ${theme.label} card. Character or object art fills the upper art window, a colored type band sits beneath it, an effect text box holds the card's rules, a flavor quote sits below, a circular salary-cost badge sits in the top-right, and a stat line sits in the bottom-right.`,
    style_description: {
      aesthetics: 'glossy original trading card game card, bright saturated cartoon illustration, humorous corporate satire, thick black border with a gold Greek meander (meandros) key pattern accent, clean modern game frame',
      lighting: 'bright even playful lighting, subtle glossy highlights',
      photo: 'crisp bold cartoon art, perfectly legible clean card typography',
      medium: 'trading card',
      color_palette: theme.palette
    },
    compositional_deconstruction: {
      canvas: 'Square canvas, upright orientation. A thick black rectangular card border with a gold Greek meander (Greek-key) pattern runs around the whole card. Do not rotate any text; all text horizontal and readable.',
      background: `A ${theme.frame} inner card frame inside a thick black gold-meander border, with a rectangular art window in the upper area and a rules text box in the lower area.`,
      elements: [
        { type: 'text', bbox: [34, 60, 118, 820], text: title, desc: 'Large bold playful card title in the top banner, horizontal.' },
        { type: 'obj', bbox: [24, 838, 150, 962], desc: 'A circular gold salary-cost badge in the top-right corner.' },
        { type: 'text', bbox: [50, 852, 126, 950], text: `$${cost}`, desc: 'Salary cost number inside the top-right gold badge.' },
        { type: 'obj', bbox: [162, 64, 582, 936], desc: art },
        { type: 'text', bbox: [600, 70, 666, 930], text: `${theme.label} — ${typeLine}`, desc: 'Type band beneath the art window, horizontal, clear.' },
        { type: 'text', bbox: [682, 80, 856, 920], text: effect, desc: 'Rules / effect text inside the text box, horizontal, clear and perfectly readable.' },
        { type: 'text', bbox: [866, 80, 922, 720], text: flavor, desc: 'Small italic flavor quote beneath the rules text, horizontal.' },
        { type: 'text', bbox: [916, 740, 980, 936], text: stats, desc: 'Stat line in the bottom-right corner, horizontal.' }
      ]
    }
  })
}

const CARDS = [
  // --- Managers (red) ---
  {
    id: 'product-manager',
    spec: {
      title: 'Product Manager',
      category: 'manager',
      cost: '4',
      art: 'A cheerful man in a slightly-too-tight blazer proudly holding a giant sticky-note roadmap board, confident grin, bright open-plan office behind him. Bright cartoon style.',
      typeLine: 'Leadership',
      effect: 'When this card enters the playing field, set up weekly syncs with engineering managers. Each Employee you control loses 1 Output at the start of your turn.',
      flavor: '"Quick question — do you have 30 minutes?"',
      stats: 'INFLUENCE 5 / OUTPUT 1'
    }
  },
  {
    id: 'engineering-manager',
    spec: {
      title: 'Engineering Manager',
      category: 'manager',
      cost: '4',
      art: 'A tired middle-aged man in a company quarter-zip pullover holding a huge coffee mug, standing in front of a whiteboard covered in boxes and arrows. Reassuring forced smile. Bright cartoon style.',
      typeLine: 'Middle Management',
      effect: 'Block target Pull Request from merging for 2 turns. Convert 1 Employee into a recurring meeting.',
      flavor: '"Let\'s circle back on this next sprint."',
      stats: 'INFLUENCE 4 / OUTPUT 2'
    }
  },
  // --- Items (blue) ---
  {
    id: 'office-chair',
    spec: {
      title: 'Office Chair',
      category: 'item',
      cost: '2',
      art: 'A deluxe ergonomic mesh office chair glowing heroically on a pedestal under a spotlight, confetti and sparkles around it. Bright cartoon style.',
      typeLine: 'Equipment',
      effect: 'Equip to an Employee. That Employee gains +2 Output and cannot be knocked out by Back Pain.',
      flavor: '"Fully adjustable lumbar support."',
      stats: 'DURABILITY 3'
    }
  },
  {
    id: 'coffee-machine',
    spec: {
      title: 'Coffee Machine',
      category: 'item',
      cost: '3',
      art: 'A shiny chrome espresso machine steaming dramatically on an office counter, heavenly beams of light shining down on it. Bright cartoon style.',
      typeLine: 'Appliance',
      effect: 'At the start of your turn, give each Employee you control +1 Output until end of turn. If destroyed, every Employee skips their next turn.',
      flavor: '"Do NOT touch the settings."',
      stats: 'DURABILITY 4'
    }
  },
  // --- Employees (green) ---
  {
    id: 'engineer',
    spec: {
      title: 'Engineer',
      category: 'employee',
      cost: '3',
      art: 'A focused young developer in a hoodie surrounded by floating glowing code windows, dual monitors, an energy drink can on the desk. Bright cartoon style.',
      typeLine: 'Individual Contributor',
      effect: 'Tap to ship one Feature. If a Bug is revealed, Engineer is exhausted until you spend a Coffee Machine.',
      flavor: '"It works on my machine."',
      stats: 'OUTPUT 4 / MORALE 2'
    }
  },
  {
    id: 'devops',
    spec: {
      title: 'DevOps',
      category: 'employee',
      cost: '3',
      art: 'A calm engineer wearing a headset standing among glowing server racks and pipeline diagrams, casually holding a fire extinguisher. Bright cartoon style.',
      typeLine: 'Individual Contributor',
      effect: 'Whenever Production catches fire, DevOps extinguishes it. Once per game, redeploy everything from orbit.',
      flavor: '"It\'s not down, it\'s just degraded."',
      stats: 'OUTPUT 3 / MORALE 1'
    }
  }
]

function printHelp () {
  const byCat = { manager: [], item: [], employee: [] }
  for (const c of CARDS) byCat[c.spec.category].push(c.id)
  console.log(`CORPORATION — Ideogram 4 card game generator

Usage:
  bare examples/generate-ideogram-tcg.js            Generate the default card (Coffee Machine, seed 42)
  bare examples/generate-ideogram-tcg.js --help     Show this help
  ONLY=<ids> bare examples/generate-ideogram-tcg.js  Generate specific cards (comma-separated ids)
  ONLY=all   bare examples/generate-ideogram-tcg.js  Generate the whole set

Cards by category (color):
  Managers  (red)   : ${byCat.manager.join(', ')}
  Items     (blue)  : ${byCat.item.join(', ')}
  Employees (green) : ${byCat.employee.join(', ')}

Environment overrides:
  ONLY   card ids to generate, or "all"   (default: coffee-machine)
  SEEDS  comma-separated seeds            (default: 42)
  STEPS  diffusion steps                  (default: ${STEPS})
  SIZE   square image size in px          (default: ${SIZE})
  CFG    classifier-free guidance scale   (default: ${CFG})

Examples:
  ONLY=all SEEDS=42,7 bare examples/generate-ideogram-tcg.js
  ONLY=engineer,devops STEPS=40 bare examples/generate-ideogram-tcg.js
  ONLY=product-manager SEEDS=42,7,123 bare examples/generate-ideogram-tcg.js`)
}

async function main () {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp()
    return
  }
  const cards = ONLY.includes('all') ? CARDS : CARDS.filter((c) => ONLY.includes(c.id))
  if (!cards.length) {
    console.error(`No matching cards for ONLY="${ONLY.join(',')}". Run with --help to see valid card ids.`)
    process.exit(1)
  }
  fs.mkdirSync(OUT, { recursive: true })
  const manifest = path.join(OUT, 'manifest.jsonl')
  fs.writeFileSync(manifest, '')
  const total = cards.length * SEEDS.length
  console.log(`CORPORATION card set — ${SIZE}x${SIZE}, ${STEPS} steps, cfg ${CFG}, seeds ${SEEDS.join(',')}, ${total} cards\n`)
  const model = new ImgStableDiffusion({
    files: FILES,
    config: { threads: 4, diffusion_fa: true, offload_to_cpu: true },
    logger: { info () {}, warn () {}, error (...a) { console.error(...a) }, debug () {} }
  })
  try {
    await model.load()
    console.log('Model loaded\n')
    let i = 0
    for (const c of cards) {
      const prompt = card(c.spec)
      for (const seed of SEEDS) {
        i++
        const t = Date.now()
        let bytes = null
        try {
          const response = await model.run({ prompt, steps: STEPS, width: SIZE, height: SIZE, cfg_scale: CFG, seed })
          await response.onUpdate((d) => { if (d instanceof Uint8Array) bytes = d }).await()
        } catch (err) { console.error(`  ${c.id} s${seed} ERROR: ${err.message || err}`) }
        const ms = Date.now() - t
        let file = null
        if (bytes) { file = path.join(OUT, `${c.id}_s${seed}.png`); fs.writeFileSync(file, bytes) }
        fs.appendFileSync(manifest, JSON.stringify({ category: c.spec.category, subject: c.spec.title, keyword: c.id, seed, file, ms }) + '\n')
        console.log(`[${i}/${total}] ${c.id} s${seed} — ${(ms / 1000).toFixed(0)}s ${bytes ? `${(bytes.length / 1024).toFixed(0)}K` : 'NO BYTES'}`)
      }
    }
    console.log(`\nDone → ${manifest}`)
  } finally {
    await model.unload()
  }
}

main().catch((err) => { console.error('Fatal:', err.message || err); process.exit(1) })
