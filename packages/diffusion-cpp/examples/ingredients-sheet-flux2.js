'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const ImgStableDiffusion = require('../index')

const modelDir = path.join(__dirname, '../models')
const outputDir = path.join(__dirname, '../output/flux2-coffee-ingredients')

const jobs = [
  {
    name: 'character',
    file: 'character.png',
    width: 768,
    height: 1024,
    seed: 118,
    prompt:
      'Unretouched live-action full-body studio casting photograph of one real human adult approximately 35 years old. Naturally vivid green irises, short neat black hair, realistic skin pores, subtle facial asymmetry, natural proportions, looking directly into the camera with a calm neutral expression and closed mouth. Standing upright with arms relaxed at the sides, wearing a simple fitted charcoal-grey cotton shirt, plain black trousers, and minimal black shoes. Entire body visible from head to feet, centered and front-facing. Completely seamless pure white cyclorama background, high-key professional photographic lighting, accurate skin texture, individual hair strands, sharp eyes, realistic fabric, natural color, photorealistic character reference photography.',
    negative:
      '3D render, CGI, video game render, cartoon, illustration, anime, painting, digital art, plastic skin, doll, mannequin, child, teenager, elderly, smile, looking away, profile, cropped head, cropped feet, extra person, duplicate, extra limbs, props, scenery, text, logo, watermark'
  },
  {
    name: 'outfit',
    file: 'scientist-outfit.png',
    width: 768,
    height: 1024,
    seed: 311,
    prompt:
      'Photorealistic full-body apparel reference photograph of a headless neutral tailoring mannequin dressed as a modern research scientist. A clean tailored light-grey laboratory coat with realistic lapels, buttons, chest pocket and two lower utility pockets, worn open over a plain fitted charcoal-black crew-neck cotton T-shirt, paired with straight dark charcoal trousers and simple black leather shoes. Professional, intelligent, practical contemporary researcher outfit, understated and believable. Straight-on front view, arms relaxed at the sides, entire outfit visible from collar to shoes, centered on a seamless pure white studio background, high-key softbox lighting, realistic fabric weave, stitching and natural folds, commercial wardrobe reference photography.',
    negative:
      'logo, text, badge, name tag, medical scrubs, stethoscope, goggles, gloves, tools, props, person, head, face, colored lab coat, cartoon, illustration, CGI, 3D render, laboratory background, grey background, cropped coat, cropped feet, side view, watermark'
  },
  {
    name: 'coffee',
    file: 'tether-coffee.png',
    width: 768,
    height: 768,
    seed: 642,
    prompt:
      'Photorealistic premium product photograph of one hot takeaway coffee in a tall matte-black paper cup with a fitted black lid. Centered clearly on the front is the exact readable brand name "Tether Coffee" in clean elegant white sans-serif typography, spelled exactly Tether Coffee, with a small minimal white circular mark above the words. Delicate natural curls of hot steam rise visibly from the lid. Sophisticated modern technology-company coffee branding, subtle recycled-paper texture, realistic cup construction, three-quarter front view, entire cup visible, centered on a seamless pure white studio background, soft commercial lighting, gentle contact shadow, crisp print detail, no hands and no other objects.',
    negative:
      'misspelled text, garbled letters, extra words, duplicate cup, multiple cups, mug, ceramic cup, glass, straw, person, hand, coffee beans, table, cafe, room, colored background, cartoon, illustration, CGI, cropped cup, watermark'
  },
  {
    name: 'furniture',
    file: 'birchwood-table-chair.png',
    width: 1024,
    height: 768,
    seed: 524,
    prompt:
      'Photorealistic premium furniture product photograph containing exactly two objects total: one birchwood table and one birchwood chair. The single clean rectangular Scandinavian work table is made from pale natural solid birch with gently rounded corners, visible fine birch grain, elegant tapered legs and precise joinery. Beside it is exactly one matching ergonomic birchwood chair with a curved back and simple sculpted wooden seat. There is no second chair and nothing is behind the table. Timeless minimalist craftsmanship, warm light honey-blonde wood, realistic proportions. Three-quarter front view showing the complete table and chair separated clearly, centered on a seamless pure white studio background, soft commercial lighting, subtle contact shadows, high-end furniture catalog photography.',
    negative:
      'person, multiple chairs, extra table, bench, stool, plastic, metal, dark wood, upholstery, objects on table, room, wall, scenery, colored background, cartoon, illustration, CGI, distorted legs, impossible joinery, cropped furniture, text, logo, watermark'
  },
  {
    name: 'environment',
    file: 'everest-clouds.png',
    width: 1024,
    height: 576,
    seed: 417,
    prompt:
      'Ultra-wide photorealistic cinematic landscape of Mount Everest rising high above a vast sea of clouds. View from a nearby high Himalayan ridge at dawn, the immense snow-covered summit centered in the distance, dramatic layered white clouds flowing through the valleys far below, crisp wind-sculpted snow and dark exposed rock in the foreground, pale blue high-altitude sky, warm golden sunrise rim light touching the summit, immense scale, clear atmospheric depth, realistic expedition photography, natural color, sharp mountain detail, panoramic 16:9 composition, no people, no buildings.',
    negative:
      'person, climber, tent, building, city, aircraft, fantasy castle, floating island, cartoon, illustration, painting, CGI, oversaturated, blurry, fog obscuring mountain, cropped summit, duplicate mountain, text, logo, watermark, border'
  }
]

function page() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=768,initial-scale=1">
<title>FLUX2 Coffee Ingredients</title>
<style>
*{box-sizing:border-box}html,body{width:768px;height:448px;margin:0;overflow:hidden;background:#161a19}
main{display:grid;grid-template-rows:250px 186px;gap:4px;width:768px;height:448px;padding:4px}
.top,.bottom{display:grid;gap:4px;min-height:0}.top{grid-template-columns:repeat(3,1fr)}.bottom{grid-template-columns:repeat(2,1fr)}
figure{min-width:0;min-height:0;margin:0;overflow:hidden;border:1px solid #e8ebe7;background:#f7f7f4}
img{display:block;width:100%;height:100%;object-fit:contain;background:#f7f7f4}.environment img{object-fit:cover}
</style></head><body><main>
<section class="top">
<figure><img src="character.png" alt="Character"></figure>
<figure><img src="scientist-outfit.png" alt="Scientist outfit"></figure>
<figure><img src="tether-coffee.png" alt="Tether Coffee"></figure>
</section>
<section class="bottom">
<figure><img src="birchwood-table-chair.png" alt="Birchwood furniture"></figure>
<figure class="environment"><img src="everest-clouds.png" alt="Everest above clouds"></figure>
</section>
</main></body></html>`
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  const selectedJobs = process.env.ONLY
    ? jobs.filter((job) => job.name.startsWith(process.env.ONLY))
    : jobs
  if (!selectedJobs.length) throw new Error(`No ingredient matches ONLY=${process.env.ONLY}`)

  const model = new ImgStableDiffusion({
    files: {
      model: path.join(modelDir, 'flux-2-klein-4b-Q8_0.gguf'),
      llm: path.join(modelDir, 'Qwen3-4B-Q4_K_M.gguf'),
      vae: path.join(modelDir, 'flux2-vae.safetensors')
    },
    config: {
      threads: 4,
      device: 'gpu',
      diffusion_fa: true,
      prediction: 'flux2_flow'
    },
    logger: console
  })

  try {
    await model.load()
    for (const [index, job] of selectedJobs.entries()) {
      console.log(`Generating ${index + 1}/${selectedJobs.length}: ${job.name}`)
      let result
      const response = await model.run({
        prompt: job.prompt,
        negative_prompt: job.negative,
        width: job.width,
        height: job.height,
        cfg_scale: 1,
        steps: Number(process.env.STEPS || 24),
        guidance: Number(process.env.GUIDANCE || 4),
        seed: job.seed
      })
      await response
        .onUpdate((data) => {
          if (data instanceof Uint8Array) result = data
        })
        .await()
      if (!result) throw new Error(`No image returned for ${job.name}`)
      fs.writeFileSync(path.join(outputDir, job.file), result)
      console.log(`Saved ${path.join(outputDir, job.file)}`)
    }

    const html = path.join(outputDir, 'index.html')
    fs.writeFileSync(html, page())
    console.log(`Reference sheet HTML: ${html}`)
    console.log('Render index.html at 768x448 to create the PNG reference sheet.')
  } finally {
    await model.unload()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
