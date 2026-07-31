'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const ImgStableDiffusion = require('../index')

const modelDir = path.join(__dirname, '../models')
const outputDir = path.join(__dirname, '../output/flux2-ingredients')
const portraitPath = process.env.INPUT_IMAGE || path.join(__dirname, '../assets/von-neumann.jpg')
const glaivePath = process.env.WARGLAIVE_REFERENCE || null

const jobs = [
  {
    file: 'portrait.png',
    title: 'The maker',
    prompt:
      'same person and same face, editorial portrait for a premium game design ingredients page, charcoal herringbone blazer, black shirt, warm studio rim light, refined dark teal background, realistic photography',
    input: portraitPath
  },
  {
    file: 'warglaive.png',
    title: 'Warglaive of Azzinoth',
    prompt:
      'single ornate twin-bladed warglaive inspired by the reference, emerald green glowing blades, black and gold demonic metal hilt, centered product photography, dramatic studio lighting, isolated on warm parchment, highly detailed fantasy game asset',
    input: glaivePath
  },
  {
    file: 'desert-dune.png',
    title: 'Nice desert hill dune',
    prompt:
      'nice desert hill dune, sweeping golden sand ridge under a pale blue sky, wind-carved textures, cinematic landscape photography, warm sunlight, minimal composition, no people, no text'
  },
  {
    file: 'dark-green-cloak.png',
    title: 'Dark-green cloak',
    prompt:
      'a simple dark forest-green hooded cloak displayed on a faceless tailoring mannequin, clean practical outfit with a plain black tunic and dark trousers, full-body studio product photography, soft neutral background, natural fabric texture, elegant and wearable, no armor, no weapons, no text'
  }
]

function page(images) {
  const cards = images
    .map(
      (image) => `
    <article class="ingredient"><img src="${image.file}" alt="${image.title}">
      <div><span>ingredient</span><h2>${image.title}</h2></div>
    </article>`
    )
    .join('\n')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Ingredients</title>
<style>
:root{color-scheme:dark;font-family:Georgia,serif}body{margin:0;background:#111615;color:#eee8d8}
main{max-width:1180px;margin:auto;padding:64px 28px 80px}header{display:flex;justify-content:space-between;gap:32px;align-items:end;margin-bottom:36px}
h1{font-size:clamp(42px,8vw,92px);line-height:.9;margin:0;font-weight:400;letter-spacing:-.06em}.dek{max-width:280px;color:#a8b4a7;line-height:1.5;margin:0}
.grid{display:grid;grid-template-columns:1.1fr .9fr;gap:18px}.ingredient{background:#1c2421;border:1px solid #33413a}.ingredient:first-child{grid-row:span 2}
img{display:block;width:100%;aspect-ratio:1;object-fit:cover}.ingredient div{padding:18px 20px 22px}
span{color:#a9d58a;text-transform:uppercase;font:11px monospace;letter-spacing:.16em}h2{font-size:25px;font-weight:400;margin:8px 0 0}
footer{margin-top:28px;color:#728077;font:12px monospace}@media(max-width:700px){header,.grid{display:block}.dek{margin-top:22px}.ingredient{margin-top:18px}}
</style></head><body><main><header><h1>Ingredients<br><em>for a world</em></h1>
<p class="dek">A visual study assembled with FLUX2-klein from one portrait, one relic, and a quiet place in the dunes.</p>
</header><section class="grid">${cards}</section><footer>FLUX2-KLEIN / IN-CONTEXT IMAGE STUDY</footer>
</main></body></html>`
}

async function main() {
  if (!fs.existsSync(portraitPath)) throw new Error(`Portrait not found: ${portraitPath}`)
  fs.mkdirSync(outputDir, { recursive: true })
  const selectedJobs = process.env.ONLY
    ? jobs.filter((job) => job.file.startsWith(process.env.ONLY))
    : jobs
  if (!selectedJobs.length) throw new Error(`No ingredient matches ONLY=${process.env.ONLY}`)
  const model = new ImgStableDiffusion({
    files: {
      model: path.join(modelDir, 'flux-2-klein-4b-Q8_0.gguf'),
      llm: path.join(modelDir, 'Qwen3-4B-Q4_K_M.gguf'),
      vae: path.join(modelDir, 'flux2-vae.safetensors')
    },
    config: { threads: 4, device: 'gpu', diffusion_fa: true, prediction: 'flux2_flow' },
    logger: console
  })

  try {
    await model.load()
    for (const [index, job] of selectedJobs.entries()) {
      console.log(`Generating ${index + 1}/${selectedJobs.length}: ${job.title}`)
      let result
      const response = await model.run({
        prompt: job.prompt,
        negative_prompt: 'blurry, low quality, NSFW, distorted, extra limbs, text, watermark',
        ...(job.input && fs.existsSync(job.input)
          ? { init_image: fs.readFileSync(job.input) }
          : {}),
        width: 768,
        height: 768,
        cfg_scale: 1,
        steps: Number(process.env.STEPS || 10),
        guidance: 5,
        seed: index + 42
      })
      await response
        .onUpdate((data) => {
          if (data instanceof Uint8Array) result = data
        })
        .await()
      if (!result) throw new Error(`No image returned for ${job.title}`)
      fs.writeFileSync(path.join(outputDir, job.file), result)
      console.log(`Saved ${path.join(outputDir, job.file)}`)
    }
    fs.writeFileSync(path.join(outputDir, 'index.html'), page(jobs))
    console.log(`Ingredients page: ${path.join(outputDir, 'index.html')}`)
  } finally {
    await model.unload()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
