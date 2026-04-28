'use strict'

const test = require('brittle')
const Addon = require('../..')

// The hello-world _load() does not actually open a file. Any existing absolute
// path satisfies the constructor's `files.model` validation; we use the test
// file itself as a stable, always-present fixture. Replace with a real model
// path when you wire a real backend.
const FIXTURE_PATH = __filename

test('integration: addon loads and runs', async (t) => {
  const addon = new Addon({ files: { model: [FIXTURE_PATH] } })
  t.teardown(async () => { await addon.unload() })
  await addon.load()

  const response = await addon.run({ name: 'integration' })
  const { text } = await response.await()
  t.is(typeof text, 'string')
  t.is(text, 'hello, integration')
})

test('integration: addon handles default name', async (t) => {
  const addon = new Addon({ files: { model: [FIXTURE_PATH] } })
  t.teardown(async () => { await addon.unload() })
  await addon.load()

  const response = await addon.run()
  const { text } = await response.await()
  t.is(text, 'hello, world')
})

test('integration: constructor rejects missing files.model', (t) => {
  let err = null
  try { const a = new Addon(); t.absent(a) } catch (e) { err = e }
  t.ok(err && /non-empty array/.test(err.message))
})
