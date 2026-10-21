'use strict'

const path = require('bare-path')
const process = require('bare-process')
const fs = require('bare-fs')

async function main () {
  const dir = path.resolve(process.env.QWEN_MODELS_DIR || path.join(__dirname, '../models/qwen-image-21'))
  const args = process.argv.slice(2)
  const portrait = path.join(__dirname, '../assets/von-neumann-colorized.jpg')
  const originalPortrait = path.join(__dirname, '../assets/von-neumann.jpg')
  const modes = {
    'text-to-image': {
      inputs: [],
      output: 'qwen-image-21-portrait.png',
      prompt: 'A photorealistic studio portrait of mathematician John von Neumann wearing a gray suit, white shirt and patterned tie, soft daylight, neutral background.'
    },
    edit: {
      inputs: [portrait],
      output: 'qwen-image-21-portrait-edit.png',
      prompt: 'Change the suit jacket in the reference portrait to dark burgundy. Preserve the person, face, hair, expression, white shirt, tie, background, lighting and framing. Keep the image photorealistic and opaque.'
    },
    compose: {
      inputs: [portrait, originalPortrait],
      output: 'qwen-image-21-handshake.png',
      prompt: 'Create one photorealistic color photograph of two men warmly shaking hands. Use the man in the first reference portrait for the person on the left and the man in the second reference portrait for the person on the right. Preserve their respective facial features, hairstyles, suits and ties. Show both men from the waist up, standing face to face at a slight angle toward the camera, with their right hands clasped together in one natural handshake clearly visible at the center. Keep both faces and the complete handshake in frame. Place them together in the same softly lit office with a neutral background, consistent perspective and natural anatomy. Colorize the second reference naturally. Output a single continuous opaque photograph, with no panels, collage, divider, text or borders.'
    },
    transparent: {
      inputs: [],
      output: 'qwen-image-21-transparent-portrait.png',
      prompt: 'A photorealistic bust portrait of mathematician John von Neumann wearing a gray suit, white shirt and patterned tie. Output an RGBA cutout with a fully transparent background and clean natural edges. No backdrop, solid background color, checkerboard or text.'
    },
    'remove-background': {
      inputs: [portrait],
      output: 'qwen-image-21-no-background.png',
      prompt: 'Remove the entire background from the reference image. Keep the foreground subject, preserving its appearance, colors, position and framing. Output an RGBA cutout with a fully transparent background and clean natural edges. Do not replace the background with a solid color or checkerboard.'
    }
  }
  if (args[0] === '--help') {
    console.log('Usage: bare examples/generate-image-qwen-21.js [--mode MODE] [reference ...]')
    console.log('Modes: ' + Object.keys(modes).join(', '))
    console.log('Each mode has bundled defaults; optional references must match its input count.')
    console.log('--remove-background [image] is an alias for --mode remove-background.')
    return
  }
  const modeName = args[0] === '--remove-background' ? 'remove-background' : args[0] === '--mode' ? args[1] : null
  if (args[0] === '--mode' && !Object.hasOwn(modes, modeName)) {
    throw new Error('Choose --mode ' + Object.keys(modes).join('|'))
  }
  const preset = modeName ? modes[modeName] : null
  const suppliedFiles = args.slice(args[0] === '--mode' ? 2 : args[0] === '--remove-background' ? 1 : 0)
  if (suppliedFiles.some(file => file.startsWith('--'))) throw new Error('Unknown option; use --help')
  if (preset && suppliedFiles.length && suppliedFiles.length !== preset.inputs.length) {
    throw new Error(`${modeName} expects ${preset.inputs.length} reference image(s); omit them to use its defaults`)
  }
  const inputFiles = suppliedFiles.length ? suppliedFiles : preset ? preset.inputs : []
  const defaultOutput = preset ? preset.output : 'qwen-image-21.png'
  const output = path.resolve(process.env.QWEN_OUTPUT || path.join(__dirname, '../output', defaultOutput))
  const refs = inputFiles.map(file => fs.readFileSync(path.resolve(file)))
  const defaultPrompt = preset ? preset.prompt : 'A red ceramic teapot on a wooden table, soft daylight, product photograph.'
  const width = Number(process.env.QWEN_WIDTH || 512)
  const height = Number(process.env.QWEN_HEIGHT || 512)
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value % 32 === 0)) {
    throw new Error('Qwen-Image-2.1 width and height must be positive multiples of 32')
  }
  const ImgStableDiffusion = require('../index')
  const model = new ImgStableDiffusion({
    files: {
      model: path.join(dir, 'qwen_image_2.1-Q4_K.gguf'),
      llm: path.join(dir, 'Qwen3VL-8B-Instruct-Q4_K_M.gguf'),
      vae: path.join(dir, 'qwen_image_2.1_vae_bf16.safetensors'),
      ...(refs.length ? { llmVision: path.join(dir, 'mmproj-Qwen3VL-8B-Instruct-F16.gguf') } : {})
    },
    config: {
      backend: process.env.QWEN_BACKEND || 'cuda0',
      params_backend: process.env.QWEN_BACKEND || 'cuda0',
      threads: 8,
      diffusion_fa: true,
      vae_conv_direct: false,
      vae_decode_only: refs.length === 0
    },
    opts: { stats: true },
    logger: console
  })
  try {
    const loadStart = Date.now()
    await model.load()
    console.log(JSON.stringify({ event: 'loaded', elapsedMs: Date.now() - loadStart }))
    const start = Date.now()
    const response = await model.run({
      prompt: process.env.QWEN_PROMPT || defaultPrompt,
      width,
      height,
      steps: Number(process.env.QWEN_STEPS || 30),
      seed: Number(process.env.QWEN_SEED || 42),
      cfg_scale: 6,
      sampling_method: 'euler',
      ...(refs.length === 1 ? { init_image: refs[0] } : refs.length > 1 ? { init_images: refs } : {})
    })
    const images = []
    await response.onUpdate(data => {
      if (data instanceof Uint8Array) images.push(data)
    }).await()
    if (images.length !== 1) throw new Error(`Expected one PNG, got ${images.length}`)
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, images[0])
    console.log(JSON.stringify({ event: 'generated', mode: modeName || 'custom', output, width, height, elapsedMs: Date.now() - start }))
  } finally {
    await model.unload()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
