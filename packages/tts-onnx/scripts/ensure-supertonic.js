'use strict'

const path = require('bare-path')
const {
  ensureSupertonicModels,
  ensureSupertonicModelsMultilingual
} = require('../test/utils/downloadModel.js')

const baseDir = '.'
const modelsDir = path.join(baseDir, 'models')

const os = require('bare-os')
const language = os.getEnv('TTS_LANGUAGE') || 'en'

async function run () {
  const errors = []

  if (language === 'en' || language === 'all') {
    const supertonicDir = path.join(modelsDir, 'supertonic')
    const r = await ensureSupertonicModels({ targetDir: supertonicDir })
    if (!r.success) errors.push('Supertonic English')
  }
  if (language === 'multilingual' || language === 'all') {
    const supertonicMultilingualDir = path.join(modelsDir, 'supertonic-multilingual')
    const r = await ensureSupertonicModelsMultilingual({ targetDir: supertonicMultilingualDir })
    if (!r.success) errors.push('Supertonic multilingual')
  }

  if (errors.length) {
    const e = new Error(`Supertonic model download failed: ${errors.join(', ')}`)
    console.error(e.message)
    throw e
  }
}

run().catch((e) => {
  console.error(e)
  throw e
})
