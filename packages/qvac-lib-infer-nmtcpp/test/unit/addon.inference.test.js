'use strict'

/**
 * Tests for Addon Inference
 *
 * These tests verify the inference process, model state transitions,
 * error handling, and the AddonInterface operations.
 */

const test = require('brittle')
const MLCMarian = require('../mocks/MockMLCMarian.js')
const FakeDL = require('../mocks/loader.fake.js')
const AddonInterface = require('../mocks/MockAddon.js')
const { transitionCb, wait } = require('../mocks/utils.js')

/**
 * Test that the inference process returns the expected output.
 *
 * The test simulates loading the model, running an inference with some text,
 * and verifies that the output callback receives an object containing the input's length.
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
 * Test that the model correctly handles state transitions.
 *
 * The test verifies that calling pause, unpause, stop, and activating/destroying the addon
 * causes the model to report the correct state.
 */
test('Model state transitions are handled correctly', async (t) => {
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

  t.ok(
    (await model.status()) === 'listening',
    'Status: Model should be listening'
  )

  await model.pause()
  t.ok((await model.status()) === 'paused', 'Status: Model should be paused')

  await model.unpause()
  t.ok(
    (await model.status()) === 'listening',
    'Status: Model should be listening'
  )

  await model.stop()
  t.ok((await model.status()) === 'stopped', 'Status: Model should be stopped')

  await model.addon.activate()
  t.ok(
    (await model.status()) === 'listening',
    'Status: Model should be listening'
  )

  await model.addon.destroy()
  t.ok((await model.status()) === 'idle', 'Status: Model should be idle')
})

/**
 * Test that the model correctly handles state transitions using the response.
 *
 * The test verifies that calling pause, activate, and cancel from the response object
 * causes the model to report the correct state.
 */
test('Response object state transitions are handled correctly', async (t) => {
  const fakeDL = new FakeDL({})
  const args = {
    loader: fakeDL,
    params: { mode: 'full', srcLang: 'en', dstLang: 'it' },
    opts: {}
  }
  const model = new MLCMarian(args, {})
  await model.load()

  const response = await model.run('hello world')

  await response.pause()
  t.ok((await model.status()) === 'paused', 'Status: Model should be paused')

  await response.continue()
  t.ok(
    (await model.status()) === 'listening',
    'Status: Model should be listening'
  )

  await response.await()
  t.ok(
    (await model.status()) === 'listening',
    'Status: Model should be listening'
  )
})

/**
 * Test that errors during processing are properly emitted and caught.
 *
 * This test overrides the addon to force an error during the append process.
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
    append: async ({ type, input }) => {
      throw new Error('Forced error for testing')
    },
    loadWeights: async () => {},
    activate: async () => {},
    pause: async () => {},
    stop: async () => {},
    cancel: async () => {},
    status: async () => 'idle',
    progress: async () => ({ processed: 0, total: 0 }),
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
 *
 * This test verifies that the loader lists the expected files and that reading from each
 * file stream returns non-empty data.
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
 * Test the complete sequence of operations for the AddonInterface.
 *
 * This test simulates loading weights, activating the addon, appending text chunks,
 * sending job end signals, and verifying that the output callbacks and job boundaries are handled correctly.
 */
test('AddonInterface full sequence: status, append, and job boundaries', async (t) => {
  const events = []
  const outputCb = (instance, eventType, jobId, data, extra) => {
    console.log(
      `Callback for job ${jobId} with event ${eventType}: ${JSON.stringify(
        data
      )}`
    )
    events.push({ eventType, jobId, data })
  }

  const addon = new AddonInterface({}, outputCb, transitionCb)

  let status = await addon.status()
  t.ok(status === 'loading', 'Initial addon status should be "loading"')

  await addon.loadWeights({ dummy: 'weightsData' })

  await addon.activate()
  status = await addon.status()
  t.ok(status === 'listening', 'Status should be "listening" after activation')

  // Append a text chunk and verify the returned job ID.
  const appendResult1 = await addon.append({ type: 'text', input: 'abcde' })
  t.ok(appendResult1 === 1, 'Job ID should be 1 for the first appended chunk')

  // Wait for the output callback to be triggered and verify output data.
  await wait()
  t.ok(
    events.find(
      (e) => e.eventType === 'Output' && e.jobId === 1 && e.data.data === 5
    ),
    'Output callback should report length 5 for input "abcde"'
  )

  const appendResult2 = await addon.append({ type: 'end of job' })
  t.ok(appendResult2 === 1, 'Job ID should remain 1 for the end-of-job signal')
  await wait()
  t.ok(
    events.find(
      (e) =>
        e.eventType === 'JobEnded' &&
        e.jobId === 1 &&
        e.data.type === 'end of job'
    ),
    'JobEnded callback should be emitted for job 1'
  )

  status = await addon.status()
  t.ok(
    status === 'listening',
    'Status should remain "listening" after job end'
  )

  // Append a text chunk with a priority, which should start a new job.
  const appendResult3 = await addon.append({
    type: 'text',
    input: 'fghijk',
    priority: 49
  })
  t.ok(
    appendResult3 === 2,
    'Job ID should increment to 2 for a new job with priority'
  )
  await wait()
  t.ok(
    events.find(
      (e) => e.eventType === 'Output' && e.jobId === 2 && e.data.data === 6
    ),
    'Output callback should report length 6 for input "fghijk"'
  )

  // Append another text chunk; it should belong to the current job (job 2).
  const appendResult4 = await addon.append({ type: 'text', input: 'lmnopq' })
  t.ok(appendResult4 === 2, 'Job ID should remain 2 for the same job')
  await wait()
  t.ok(
    events.find(
      (e) => e.eventType === 'Output' && e.jobId === 2 && e.data.data === 6
    ),
    'Output callback should report length 6 for input "lmnopq"'
  )

  // Append end-of-job signal for job 2.
  const appendResult5 = await addon.append({ type: 'end of job' })
  t.ok(
    appendResult5 === 2,
    'Job ID should be 2 for the end-of-job signal of job 2'
  )
  await wait()
  t.ok(
    events.find((e) => e.eventType === 'JobEnded' && e.jobId === 2),
    'JobEnded callback should be emitted for job 2'
  )

  // Append a redundant end-of-job marker; this should start a new job (job 3).
  const appendResult6 = await addon.append({ type: 'end of job' })
  t.ok(
    appendResult6 === 3,
    'Job ID should increment to 3 for a redundant end-of-job signal'
  )
  await wait()
  t.ok(
    events.find((e) => e.eventType === 'JobEnded' && e.jobId === 3),
    'JobEnded callback should be emitted for job 3'
  )

  t.end()
})
