'use strict'

const path = require('bare-path')
const { ensureChatterboxModels } = require('../test/utils/downloadModel.js')

const targetDir = path.join('.', 'models', 'chatterbox')

ensureChatterboxModels({ targetDir, variant: 'fp32' })
  .then((r) => {
    if (!r.success) {
      throw new Error('Chatterbox model download failed')
    }
  })
  .catch((e) => {
    console.error(e)
    throw e
  })
