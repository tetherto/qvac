'use strict'

const path = require('bare-path')
const {
  ensureChatterboxModels,
  ensureSupertonicModels,
  ensureSupertonicModelsMultilingual,
  ensureLavaSRModels
} = require('../test/utils/downloadModel.js')

const baseDir = '.'
const modelsDir = path.join(baseDir, 'models')

const os = require('bare-os')
const variant = os.getEnv('CHATTERBOX_VARIANT') || 'q4'
const language = os.getEnv('TTS_LANGUAGE') || 'en'

async function run () {
  const errors = []
  const languages = language === 'all' ? ['en', 'multilingual'] : [language]

  for (const lang of languages) {
    const chatterboxDir = path.join(modelsDir, lang === 'en' ? 'chatterbox' : 'chatterbox-multilingual')
    const rChatter = await ensureChatterboxModels({ targetDir: chatterboxDir, variant, language: lang })
    if (!rChatter.success) errors.push(`Chatterbox ${lang} ${variant}`)
  }

  for (const lang of languages) {
    if (lang === 'en') {
      const supertonicDir = path.join(modelsDir, 'supertonic')
      const rSuper = await ensureSupertonicModels({ targetDir: supertonicDir })
      if (!rSuper.success) errors.push('Supertonic English')
    } else {
      const supertonicMultilingualDir = path.join(modelsDir, 'supertonic-multilingual')
      const rSuperML = await ensureSupertonicModelsMultilingual({ targetDir: supertonicMultilingualDir })
      if (!rSuperML.success) errors.push('Supertonic multilingual')
    }
  }

  const lavasrDir = path.join(modelsDir, 'lavasr')
  const rLavasr = await ensureLavaSRModels({ targetDir: lavasrDir })
  if (!rLavasr.success) errors.push('LavaSR')
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
