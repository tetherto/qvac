'use strict'

const test = require('brittle')

// ESM named imports depend on cjs-module-lexer statically discovering the
// exports — only a runtime import exercises that, not the type-level tests.
test('ESM named exports are statically discoverable', async (t) => {
  const ns = await import('../../index.js')

  t.is(typeof ns.VlaModel, 'function', 'VlaModel named export')
  t.is(typeof ns.preprocessImage, 'function', 'preprocessImage named export')
  t.is(typeof ns.padState, 'function', 'padState named export')
  t.is(typeof ns.DEFAULT_IMAGE_SIZE, 'number', 'DEFAULT_IMAGE_SIZE named export')
  t.is(typeof ns.QvacErrorAddonVla, 'function', 'QvacErrorAddonVla named export')
  t.is(typeof ns.ERR_CODES, 'object', 'ERR_CODES named export')

  t.is(typeof ns.default, 'function', 'default export is the class')
  t.is(ns.default, ns.VlaModel, 'default and named VlaModel are the same binding')
})
