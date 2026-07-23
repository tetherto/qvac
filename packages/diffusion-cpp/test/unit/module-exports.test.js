'use strict'

const test = require('brittle')
const cjsModule = require('../../index.js')

test('package root preserves CommonJS and ESM class exports in Bare', async function (t) {
  const esmModule = await import('../../index.js')

  t.is(cjsModule.ImgStableDiffusion, cjsModule)
  t.is(esmModule.default, cjsModule)
  t.is(esmModule.ImgStableDiffusion, cjsModule)
})
