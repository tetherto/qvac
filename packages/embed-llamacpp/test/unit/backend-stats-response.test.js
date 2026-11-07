'use strict'

const test = require('brittle')
const GGMLBert = require('../../index.js')

test('native backend names reach embedding responses only when stats are enabled', async (t) => {
  for (const stats of [true, false]) {
    const model = new GGMLBert({
      files: { model: ['/models/test.gguf'] },
      config: { device: 'gpu' },
      opts: { stats },
      logger: { info() {}, warn() {}, error() {}, debug() {} }
    })
    model.addon = { runJob: () => Promise.resolve(true) }
    const response = await model.run('hello')
    const updates = []
    response.on('stats', (value) => updates.push(value))
    model._addonOutputCallback(null, 'Embeddings', [[0.5]], null)
    model._addonOutputCallback(
      null,
      'Stats',
      { total_tokens: 1, backendDevice: 1, backendName: 'metal' },
      null
    )
    t.alike(await response.await(), [[[0.5]]])
    if (stats) {
      t.is(response.stats.backendName, 'metal')
      t.is(response.stats.backendDevice, 'gpu')
      t.is(updates[0].backendName, 'metal', 'the stats event includes the native name')
    } else {
      t.alike(response.stats, {}, 'disabled stats do not expose the backend name')
      t.alike(updates, [], 'disabled stats emit no stats event')
    }
  }
})
