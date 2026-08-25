'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { ParakeetConfigSchema } = require('../src/validation')

test('accepts Indic Conformer with a language', () => {
  const config = ParakeetConfigSchema.parse({
    modelType: 'indic-conformer',
    language: 'hi'
  })

  assert.equal(config.language, 'hi')
})

test('rejects Indic Conformer without a language', () => {
  assert.throws(
    () => ParakeetConfigSchema.parse({ modelType: 'indic-conformer' }),
    /Indic Conformer requires a language/
  )
})
