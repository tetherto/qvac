'use strict'

// pause()/unpause() are orchestrator-level rejections in the unified package:
// they never touch the driver and always reject with the structured
// NOT_SUPPORTED error (6019) until an engine truly supports them. whisper's
// old stop() is retired entirely.

const test = require('brittle')
const ASRGgml = require('../../index.js')
const { createWhisperModel, createParakeetModel } = require('../mocks/createModel.js')

const process = require('bare-process')
global.process = process

async function assertNotSupported(t, promiseFactory, label) {
  try {
    await promiseFactory()
    t.fail(`${label} should reject`)
  } catch (error) {
    t.is(error.code, ASRGgml.ERR_CODES.NOT_SUPPORTED, `${label} rejects with NOT_SUPPORTED`)
    t.is(
      error.constructor.name,
      'QvacErrorAddonASRGgml',
      `${label} rejects with the unified error class`
    )
    t.ok(
      /not supported/i.test(String(error.message)),
      `${label} carries the NOT_SUPPORTED message text`
    )
  }
}

test('whisper: pause/unpause reject with structured NOT_SUPPORTED', async (t) => {
  const { model } = createWhisperModel()

  // Rejection is orchestrator-level: it works before load too.
  await assertNotSupported(t, () => model.pause(), 'pause before load')
  await assertNotSupported(t, () => model.unpause(), 'unpause before load')

  await model.load()
  await assertNotSupported(t, () => model.pause(), 'pause after load')
  await assertNotSupported(t, () => model.unpause(), 'unpause after load')

  t.is(await model.status(), 'listening', 'unsupported pause leaves the addon state untouched')
  await model.destroy()
})

test('parakeet: pause/unpause reject with structured NOT_SUPPORTED', async (t) => {
  const { model } = createParakeetModel()

  await assertNotSupported(t, () => model.pause(), 'pause before load')
  await assertNotSupported(t, () => model.unpause(), 'unpause before load')

  await model.load()
  await assertNotSupported(t, () => model.pause(), 'pause after load')
  await assertNotSupported(t, () => model.unpause(), 'unpause after load')

  t.is(await model.status(), 'listening', 'unsupported pause leaves the addon state untouched')
  await model.destroy()
})

test('stop() is retired from the public surface', (t) => {
  const { model } = createWhisperModel()
  t.is(typeof model.stop, 'undefined', "whisper's throw-only stop() did not survive the merge")
})
