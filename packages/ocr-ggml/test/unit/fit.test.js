'use strict'

const test = require('brittle')
const { assessFit } = require('../..')

test('assessFit rejects relative model paths before loading the binding', async (t) => {
  await t.exception.all(
    () => assessFit({ pathDetector: 'craft.gguf', pathRecognizer: '/models/latin.gguf' }),
    /pathDetector must be an absolute path/
  )
  await t.exception.all(
    () => assessFit({ pathDetector: '/models/craft.gguf', pathRecognizer: 'latin.gguf' }),
    /pathRecognizer must be an absolute path/
  )
})

test('assessFit rejects invalid memory margins before loading the binding', async (t) => {
  for (const marginBytes of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await t.exception.all(
      () =>
        assessFit({
          pathDetector: '/models/craft.gguf',
          pathRecognizer: '/models/latin.gguf',
          marginBytes
        }),
      /marginBytes must be a non-negative safe integer/
    )
  }
})
