'use strict'

/**
 * Tests for Addon Inference
 *
 * These tests verify the inference process, output handling,
 * error handling, and the AddonInterface operations using the
 * new API (runJob instead of append, no status/pause/stop).
 */

const test = require('brittle')
const MLCMarian = require('../mocks/MockMLCMarian.js')
const FakeDL = require('../mocks/loader.fake.js')
const AddonInterface = require('../mocks/MockAddon.js')
const { wait } = require('../mocks/utils.js')

/**
 * Test that the inference process returns the expected output.
 */
test('Inference returns correct output and completes translation', async (t) => {
  const fakeDL = new FakeDL({})
  const args = {
    loader: fakeDL,
    params: { mode: 'full', srcLang: 'en', dstLang: 'it' },
    opts: {}
  }
  const model = new MLCMarian(args, {})
  await model.load()

  const text = 'test translation'
  const response = await model.run(text)

  response.onUpdate((output) => {
    t.alike(output, { type: 'number', data: text.length })
  })

  await response.await()
})

/**
 * Test that cancel and destroy work correctly.
 */
test('Cancel and destroy operations complete without errors', async (t) => {
  const fakeDL = new FakeDL({})
  const args = {
    loader: fakeDL,
    params: { mode: 'full', srcLang: 'en', dstLang: 'it' },
    opts: {}
  }
  const model = new MLCMarian(args, {})
  await model.load()

  const response = await model.run('hello world')
  await response.await()

  await model.addon.cancel()
  t.pass('Cancel completed without error')

  await model.addon.destroy()
  t.pass('Destroy completed without error')
})

/**
 * Test that errors during processing are properly emitted and caught.
 */
test('Model emits error events when an error occurs during processing', async (t) => {
  const fakeDL = new FakeDL({})
  const args = {
    loader: fakeDL,
    params: { mode: 'full', srcLang: 'en', dstLang: 'it' },
    opts: {}
  }
  const model = new MLCMarian(args, {})

  model.createAddon = (cp) => ({
    runJob: ({ type, input }) => {
      throw new Error('Forced error for testing')
    },
    loadWeights: async () => {},
    activate: async () => {},
    cancel: async () => {},
    destroy: async () => {}
  })
  await model.load()

  let errorCaught = false
  try {
    await model.run('trigger error')
  } catch (err) {
    errorCaught = true
    t.is(err.message, 'Forced error for testing')
  }
  t.ok(errorCaught, 'Error event should be caught')
})

/**
 * Test that the FakeDL loader returns the correct file list and data streams.
 */
test('FakeDL returns correct file list and data streams', async (t) => {
  const fakeDL = new FakeDL({})

  const fileList = await fakeDL.list('/')
  t.alike(
    fileList.sort(),
    ['1.bin', '2.bin', 'conf.json'].sort(),
    'File list should match expected files'
  )

  for (const file of fileList) {
    const stream = await fakeDL.getStream(file)
    let data = ''
    for await (const chunk of stream) {
      data += chunk.toString()
    }
    t.ok(data.length > 0, `Stream for ${file} should contain data`)
  }
})

/**
 * Test the AddonInterface runJob and output callback flow.
 */
test('AddonInterface runJob triggers output callback correctly', async (t) => {
  const events = []
  const outputCb = (instance, eventType, data, error) => {
    events.push({ eventType, data, error })
  }

  const addon = new AddonInterface({}, outputCb)

  await addon.activate()

  const accepted = addon.runJob({ type: 'text', input: 'abcde' })
  t.ok(accepted === true, 'runJob should return true')

  await wait()

  t.ok(
    events.some(e => e.data && e.data.type === 'number' && e.data.data === 5),
    'Output callback should report length 5 for input "abcde"'
  )

  t.ok(
    events.some(e => e.data && e.data.TPS !== undefined),
    'Stats callback should be emitted with TPS'
  )
})

/**
 * Test that runJob returns false after addon is destroyed.
 */
test('AddonInterface runJob returns false after destroy', async (t) => {
  const outputCb = () => {}
  const addon = new AddonInterface({}, outputCb)

  await addon.activate()
  await addon.destroy()

  const accepted = addon.runJob({ type: 'text', input: 'test' })
  t.ok(accepted === false, 'runJob should return false after destroy')
})

/**
 * Test batch (sequences) mode via AddonInterface.
 */
test('AddonInterface runJob handles sequences type', async (t) => {
  const events = []
  const outputCb = (instance, eventType, data, error) => {
    events.push({ eventType, data, error })
  }

  const addon = new AddonInterface({}, outputCb)
  await addon.activate()

  const accepted = addon.runJob({ type: 'sequences', input: ['hello', 'world'] })
  t.ok(accepted === true, 'runJob should accept sequences')

  await wait()

  t.ok(
    events.some(e => Array.isArray(e.data) && e.data.length === 2),
    'Output callback should receive array result for batch'
  )

  t.ok(
    events.some(e => e.data && e.data.TPS !== undefined),
    'Stats callback should be emitted after batch'
  )
})
