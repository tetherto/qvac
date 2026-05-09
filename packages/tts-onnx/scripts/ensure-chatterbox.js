'use strict'

const path = require('bare-path')
const { ensureChatterboxModels } = require('../test/utils/downloadModel.js')

const baseDir = '.'
const modelsDir = path.join(baseDir, 'models')

const os = require('bare-os')
const variant = os.getEnv('CHATTERBOX_VARIANT') || 'q4'
const language = os.getEnv('TTS_LANGUAGE') || 'en'

async function run () {
  const errors = []
  const languages = language === 'all' ? ['en', 'multilingual'] : [language]

  for (const lang of languages) {
    const dir = path.join(modelsDir, lang === 'en' ? 'chatterbox' : 'chatterbox-multilingual')
    const r = await ensureChatterboxModels({ targetDir: dir, variant, language: lang })
    if (!r.success) errors.push(`Chatterbox ${lang} ${variant}`)
  }

  if (errors.length) {
    const e = new Error(`Chatterbox model download failed: ${errors.join(', ')}`)
    console.error(e.message)
    throw e
  }
}

run().catch((e) => {
  console.error(e)
  throw e
})
