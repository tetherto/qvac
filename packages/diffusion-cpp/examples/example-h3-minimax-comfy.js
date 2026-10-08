'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const ImgStableDiffusion = require('../index')
const { runH3Video, requireImage, OUTPUT_DIR } = require('./h3-video-common')

const IMAGE_PROMPT =
  process.env.FLUX_IMAGE_PROMPT ||
  'Polished fisheye commercial keyframe: an adult woman in a bright yellow raincoat crouches beside a lush jungle waterfall, extending a rainbow-gradient soda can close to the lens. Crisp condensation on the can, turquoise pool, hyper-saturated summer light, premium product photography, dynamic foreground, clean composition, no text.'

const VIDEO_PROMPT =
  process.env.H3_PROMPT ||
  `Vibrant fisheye product commercial, hyper-saturated summer light, the woman in the supplied first-frame image wears a yellow raincoat and crouches by a jungle waterfall holding a rainbow-gradient soda can toward the lens, condensation dripping.
MUSIC: an upbeat tropical house track drives the entire film — punchy kick drum, bright steel-drum plucks, warm bass groove.

CUT 1: the fisheye hero frame — as she looks into the lens, GIANT BOLD TYPOGRAPHY stamps across the background behind her, one word per beat: "STAY" then "HYDRATED" — massive clean white block letters spanning the whole scene, curving with the fisheye distortion, sitting behind her but in front of the waterfall. She reaches her opposite hand towards the can and hooks a finger under the tab.
TRANSITION: extreme close-up of the tab — it OPENS with a crisp CLICK-hiss, and exactly on the click the fisheye lens iris shutters closed to black, like a camera blinking.
CUT 2: the iris reopens on a new POV — the can EXTREMELY distorted in the foreground, huge and warped by the fisheye, she smiles and dumps the liquid out of the can onto the floor, droplets scattering weightlessly, sunlight refracting rainbow through the stream, the waterfall soft behind her.
TRANSITION: she lowers the can and one fat droplet falls toward the lens, filling the frame —
CUT 3: through the droplet into the final wide: the rainbow can floating upright and serene in the turquoise waterfall pool, label facing camera, bobbing gently in the mist, the waterfall thundering softly behind — and "STAY COMFY" shimmering as a reflection on the water's surface beside it. Hold the product hero frame.
Crisp, joyful, premium product-ad energy. Fisheye distortion in every shot.`

async function generateKeyframe(outputPath, width, height) {
  const modelsDir = path.resolve(process.env.FLUX_MODELS_DIR || path.join(__dirname, '../models'))
  const files = {
    model: path.resolve(modelsDir, process.env.FLUX_MODEL || 'flux-2-klein-4b-Q8_0.gguf'),
    llm: path.resolve(modelsDir, process.env.FLUX_LLM || 'Qwen3-4B-Q4_K_M.gguf'),
    vae: path.resolve(modelsDir, process.env.FLUX_VAE || 'flux2-vae.safetensors')
  }
  for (const [name, filePath] of Object.entries(files)) {
    if (!fs.existsSync(filePath)) throw new Error(`Missing FLUX.2 ${name}: ${filePath}`)
  }

  const config = {
    device: process.env.FLUX_DEVICE || 'gpu',
    diffusion_fa: true,
    prediction: 'flux2_flow'
  }
  if (process.env.FLUX_BACKEND) config.backend = process.env.FLUX_BACKEND
  const model = new ImgStableDiffusion({ files, config, logger: console })
  try {
    await model.load()
    const response = await model.run({
      prompt: IMAGE_PROMPT,
      width,
      height,
      steps: Number(process.env.FLUX_STEPS || 20),
      guidance: Number(process.env.FLUX_GUIDANCE || 3.5),
      seed: Number(process.env.FLUX_SEED || 42)
    })
    let png
    await response
      .onUpdate((data) => {
        if (data instanceof Uint8Array) png = data
      })
      .await()
    if (!png) throw new Error('FLUX.2 completed without a PNG keyframe')
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, png)
    console.log(`Saved FLUX.2 keyframe: ${outputPath}`)
  } finally {
    await model.unload()
  }
}

async function main() {
  const width = Number(process.env.H3_WIDTH || 960)
  const height = Number(process.env.H3_HEIGHT || 544)
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width % 32 ||
    height % 32
  ) {
    throw new Error('H3_WIDTH and H3_HEIGHT must be positive multiples of 32')
  }
  const still = path.resolve(
    process.env.H3_INPUT_IMAGE ||
      process.env.H3_STILL ||
      path.join(OUTPUT_DIR, 'minimax-h3-comfy-keyframe.png')
  )
  if (process.env.H3_SKIP_FLUX !== '1') await generateKeyframe(still, width, height)
  // FLUX.2 generates at H3's requested geometry. Check the serialized PNG
  // before handing the bytes across the async video binding.
  requireImage(still, width, height)
  await runH3Video({
    mode: 'img2vid',
    imagePath: still,
    prompt: VIDEO_PROMPT,
    outputPath: process.env.H3_OUTPUT || path.join(OUTPUT_DIR, 'minimax-h3-comfy.avi')
  })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
