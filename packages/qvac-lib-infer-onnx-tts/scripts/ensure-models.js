'use strict'

const path = require('bare-path')
const {
  ensureChatterboxModels,
  ensureSupertonicModels,
  ensureSupertonicModelsMultilingual
} = require('../test/utils/downloadModel.js')

const baseDir = '.'
const modelsDir = path.join(baseDir, 'models')

const env = typeof process !== 'undefined' && process.env ? process.env : {}
const variant = env.CHATTERBOX_VARIANT || 'fp32'
const language = env.CHATTERBOX_LANGUAGE || 'en'
const ensureAll = env.TTS_ENSURES === 'all'

async function run () {
  const errors = []

  if (ensureAll) {
    const chatterboxSets = [
      { language: 'en', variant: 'fp32' },
      { language: 'en', variant: 'fp16' },
      { language: 'en', variant: 'q4' },
      { language: 'en', variant: 'q4f16' },
      { language: 'multilingual', variant: 'fp32' }
    ]
    for (const opts of chatterboxSets) {
      const targetDir = path.join(modelsDir, opts.language === 'en' ? 'chatterbox' : 'chatterbox-multilingual')
      const r = await ensureChatterboxModels({ targetDir, language: opts.language, variant: opts.variant })
      if (!r.success) errors.push(`Chatterbox ${opts.language} ${opts.variant}`)
    }
    const supertonicDir = path.join(modelsDir, 'supertonic')
    const rSuper = await ensureSupertonicModels({ targetDir: supertonicDir })
    if (!rSuper.success) errors.push('Supertonic English')
    const supertonicMultilingualDir = path.join(modelsDir, 'supertonic-multilingual')
    const rSuperML = await ensureSupertonicModelsMultilingual({ targetDir: supertonicMultilingualDir })
    if (!rSuperML.success) errors.push('Supertonic multilingual')
  } else {
    const chatterboxDir = path.join(modelsDir, language === 'en' ? 'chatterbox' : 'chatterbox-multilingual')
    const rChatter = await ensureChatterboxModels({ targetDir: chatterboxDir, variant, language })
    if (!rChatter.success) errors.push(`Chatterbox ${language} ${variant}`)

    const supertonicDir = path.join(modelsDir, 'supertonic')
    const rSuper = await ensureSupertonicModels({ targetDir: supertonicDir })
    if (!rSuper.success) errors.push('Supertonic English')
    const supertonicMultilingualDir = path.join(modelsDir, 'supertonic-multilingual')
    const rSuperML = await ensureSupertonicModelsMultilingual({ targetDir: supertonicMultilingualDir })
    if (!rSuperML.success) errors.push('Supertonic multilingual')
  }

  if (errors.length) {
    const e = new Error(`Model download failed: ${errors.join(', ')}`)
    console.error(e.message)
    throw e
  }
}

run().catch((e) => {
  console.error(e)
  throw e
})
