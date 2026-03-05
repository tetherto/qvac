'use strict'

const path = require('bare-path')
const process = require('bare-process')
const FilesystemDL = require('@qvac/dl-filesystem')
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

  // ── 1. Filesystem loader (serves pre-downloaded weights from disk) ─────────
  const loader = new FilesystemDL({ dirPath: MODELS_DIR })

  // ── 2. Construct — stores config, allocates nothing ───────────────────────
  const model = new ImgStableDiffusion(
    {
      loader,
      logger: console,
      diskPath: MODELS_DIR,
      modelName: MODEL_NAME,
      llmModel: LLM_MODEL,
      vaeModel: VAE_MODEL
    },
    {
      threads: 8 // Metal handles GPU; threads are for CPU fallback ops
    }
  )

  try {
    // ── 3. Load — reads weights into memory via activate() → new_sd_ctx() ───
    console.log('Loading model weights (this takes a moment)...')
    const t0 = Date.now()
    await model.load()
    console.log(`Model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    console.log()

    // ── 4. Model is live — add inference calls here ───────────────────────
    console.log('Model is ready. (No inference in this example.)')
    console.log()
  } finally {
    // ── 5. Unload — calls free_sd_ctx, releases all GPU/CPU memory ─────────
    console.log('Unloading model...')
    await model.unload()
    await loader.close()
    console.log('Done — all resources released.')
  }
}

main().catch(err => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})
