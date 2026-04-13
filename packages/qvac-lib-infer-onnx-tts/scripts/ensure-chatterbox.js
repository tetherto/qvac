'use strict'

const path = require('bare-path')
const { ensureChatterboxModels } = require('../test/utils/downloadModel.js')

const baseDir = '.'
const modelsDir = path.join(baseDir, 'models')

const os = require('bare-os')
const variant = os.getEnv('CHATTERBOX_VARIANT') || 'q4'
const language = os.getEnv('TTS_LANGUAGE') || 'en'

async function run () {
  const chatterboxDir = path.join(modelsDir, language === 'en' ? 'chatterbox' : 'chatterbox-multilingual')
  const r = await ensureChatterboxModels({ targetDir: chatterboxDir, variant, language })
  if (!r.success) {
    const e = new Error(`Chatterbox model download failed (${language} ${variant})`)
    console.error(e.message)
    throw e
  }
}

run().catch((e) => {
  console.error(e)
  throw e
})
