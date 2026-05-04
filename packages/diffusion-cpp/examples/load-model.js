'use strict'

const path = require('bare-path')
const process = require('bare-process')
const ImgStableDiffusion = require('../index')

// ---------------------------------------------------------------------------
// Model files — must have been downloaded first via:
//   ./scripts/download-model.sh
// ---------------------------------------------------------------------------
const MODELS_DIR = path.resolve(__dirname, '../models')

const MODEL_NAME = 'flux-2-klein-4b-Q8_0.gguf'
const LLM_MODEL = 'Qwen3-4B-Q4_K_M.gguf'
const VAE_MODEL = 'flux2-vae.safetensors'

async function main () {
  console.log('FLUX.2 [klein] 4B — load/unload example')
  console.log('========================================')
  console.log('Models dir :', MODELS_DIR)
  console.log('Model      :', MODEL_NAME)
  console.log('LLM encoder:', LLM_MODEL)
  console.log('VAE        :', VAE_MODEL)
  console.log()

  // ── 1. Construct — stores config, allocates nothing ────────────────────────
  const model = new ImgStableDiffusion({
    files: {
      model: path.join(MODELS_DIR, MODEL_NAME),
      llm: path.join(MODELS_DIR, LLM_MODEL),
      vae: path.join(MODELS_DIR, VAE_MODEL)
    },
    config: {
      threads: 8 // Metal handles GPU; threads are for CPU fallback ops
    },
    logger: console
  })

  try {
    // ── 2. Load — reads weights into memory via activate() → new_sd_ctx() ───
    console.log('Loading model weights (this takes a moment)...')
    const t0 = Date.now()
    await model.load()
    console.log(`Model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    console.log()

    // ── 3. Model is live — add inference calls here ───────────────────────
    console.log('Model is ready. (No inference in this example.)')
    console.log()
  } finally {
    // ── 4. Unload — calls free_sd_ctx, releases all GPU/CPU memory ─────────
    console.log('Unloading model...')
    await model.unload()
    console.log('Done — all resources released.')
  }
}

main().catch(err => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})
