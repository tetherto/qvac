'use strict'

const test = require('brittle')

// Guards the CJS→ESM interop surface: Node's and Bare's module lexers must be
// able to statically discover the attached members of `module.exports` so ESM
// consumers (like the SDK's `import { VlaModel } from '@qvac/vla-ggml'`) link.
// A type-level test cannot catch this — the declarations can be correct while
// the lexer sees nothing — so this test exercises the real runtime import
// machinery via dynamic import.
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
