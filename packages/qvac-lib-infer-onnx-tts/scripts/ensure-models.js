'use strict'

const path = require('bare-path')
const {
  ensureChatterboxModels,
  ensureSupertonicModels,
  ensureSupertonicModelsMultilingual
} = require('../test/utils/downloadModel.js')

const baseDir = '.'
const modelsDir = path.join(baseDir, 'models')

const os = require('bare-os')
const variant = os.getEnv('CHATTERBOX_VARIANT') || 'q4'
const language = os.getEnv('TTS_LANGUAGE') || 'en'

async function run () {
  const errors = []

  const chatterboxDir = path.join(modelsDir, language === 'en' ? 'chatterbox' : 'chatterbox-multilingual')
  const rChatter = await ensureChatterboxModels({ targetDir: chatterboxDir, variant, language })
  if (!rChatter.success) errors.push(`Chatterbox ${language} ${variant}`)

  if (language === 'en') {
    const supertonicDir = path.join(modelsDir, 'supertonic')
    const rSuper = await ensureSupertonicModels({ targetDir: supertonicDir })
    if (!rSuper.success) errors.push('Supertonic English')
  } else {
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
