'use strict'

const test = require('brittle')
const { MegaLoc } = require('../../index')

test('MegaLoc validates required path and CPU thread configuration', async function (t) {
  await t.exception.all(() => new MegaLoc(), /modelPath is required/)
  await t.exception.all(() => new MegaLoc({ modelPath: '' }), /modelPath is required/)
  for (const threads of [0, -1, 1.5, NaN, Infinity, 1025]) {
    await t.exception.all(() => new MegaLoc({ modelPath: 'missing.gguf', threads }), /threads/)
  }
})

test('MegaLoc missing weights leave a reusable unloaded state', async function (t) {
  const model = new MegaLoc({ modelPath: `nonexistent-megaloc-${Date.now()}.gguf` })
  await t.exception.all(() => model.load(), /not found/)
  t.alike(model.getState(), { configLoaded: false, destroyed: false })
  await model.unload()
  await model.destroy()
  await t.exception.all(() => model.load(), /destroyed/)
})
