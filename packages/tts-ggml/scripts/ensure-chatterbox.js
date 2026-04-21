'use strict'

const path = require('bare-path')
const { ensureChatterboxModels } = require('../test/utils/downloadModel.js')

const modelsDir = path.join('.', 'models')

async function run () {
  const r = await ensureChatterboxModels({ targetDir: modelsDir })
  if (!r.success) {
    const e = new Error('Chatterbox GGUFs are not available locally (see instructions above).')
    console.error(e.message)
    throw e
  }
}

run().catch((e) => {
  console.error(e)
  throw e
})
