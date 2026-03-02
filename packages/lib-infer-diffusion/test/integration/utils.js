'use strict'

const fs = require('bare-fs')
const path = require('bare-path')

const MODELS_DIR = path.resolve(__dirname, '../../models')

const FLUX2_MODELS = {
  model: 'flux-2-klein-4b-Q8_0.gguf',
  llm: 'Qwen3-4B-Q6_K.gguf',
  vae: 'flux2-vae.safetensors'
}

function ensureFlux2Models () {
  const missing = []
  for (const [key, filename] of Object.entries(FLUX2_MODELS)) {
    const fullPath = path.join(MODELS_DIR, filename)
    if (!fs.existsSync(fullPath)) {
      missing.push(`${key}: ${filename}`)
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing model files in ${MODELS_DIR}:\n  ${missing.join('\n  ')}\n` +
      'Run ./scripts/download-model.sh first.'
    )
  }

  return {
    modelsDir: MODELS_DIR,
    modelName: FLUX2_MODELS.model,
    llmModel: FLUX2_MODELS.llm,
    vaeModel: FLUX2_MODELS.vae
  }
}

async function collectImages (response) {
  const images = []
  const ticks = []
  await response
    .onUpdate(data => {
      if (data instanceof Uint8Array) {
        images.push(data)
      } else if (typeof data === 'string') {
        try { ticks.push(JSON.parse(data)) } catch (_) {}
      }
    })
    .await()
  return { images, ticks }
}

module.exports = {
  MODELS_DIR,
  FLUX2_MODELS,
  ensureFlux2Models,
  collectImages
}
