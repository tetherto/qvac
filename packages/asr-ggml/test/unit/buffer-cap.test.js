'use strict'

// MAX_BUFFERED_BYTES is a cap on the audio the CALLER hands to a single
// batch run(), not on the bytes that end up on the native wire. The whisper
// driver converts every input to f32 samples in JS before append(), which
// doubles the byte count of s16le input (the default, and by far the most
// common whisper input), so the interface scales its wire-byte budget by the
// source -> wire expansion factor. Without the scaling, a 3-hour s16le
// recording that the pre-merge whisper package accepted (345.6 MB of caller
// bytes) would be rejected with BUFFER_LIMIT_EXCEEDED at 691.2 MB of f32.

const test = require('brittle')
const { MAX_BUFFERED_BYTES } = require('../../lib/constants.js')
const { createWhisperModel, getAddon } = require('../mocks/createModel.js')

const process = require('bare-process')
global.process = process

const KB = 1024
const SECONDS_PER_HOUR = 3600
const SAMPLE_RATE = 16000

test('s16le input (default) gets the full 500 MB source budget', async (t) => {
  const { model } = createWhisperModel()
  await model.load()
  const addon = getAddon(model)

  t.is(addon._sourceByteFormat, 's16le', 'the default whisper byte format is s16le')
  t.is(
    addon._maxBufferedWireBytes(),
    MAX_BUFFERED_BYTES * 2,
    '500 MB of s16le source audio is 1 GB of f32 wire bytes'
  )

  const hours = MAX_BUFFERED_BYTES / 2 / SAMPLE_RATE / SECONDS_PER_HOUR
  t.ok(hours > 4.5, `the cap still accepts ${hours.toFixed(2)} h of 16 kHz mono s16le`)

  await model.destroy()
})

test('f32le input keeps the unscaled 500 MB budget', async (t) => {
  const { model } = createWhisperModel({ config: { audio_format: 'f32le' } })
  await model.load()
  const addon = getAddon(model)

  t.is(addon._sourceByteFormat, 'f32le', 'audio_format: f32le is honoured')
  t.is(
    addon._maxBufferedWireBytes(),
    MAX_BUFFERED_BYTES,
    'f32 input needs no expansion, so the wire budget is the source budget'
  )

  await model.destroy()
})

test('the scaled budget is enforced at its boundary', async (t) => {
  const { model } = createWhisperModel()
  await model.load()
  const addon = getAddon(model)

  // Fake the accounting rather than allocating a gigabyte of audio.
  addon._bufferedBytes = MAX_BUFFERED_BYTES * 2 - 4 * KB
  await addon.append({ type: 'audio', input: new Uint8Array(4 * KB) })
  t.is(
    addon._bufferedBytes,
    MAX_BUFFERED_BYTES * 2,
    'a chunk that exactly fills the budget is accepted'
  )

  try {
    await addon.append({ type: 'audio', input: new Uint8Array(4) })
    t.fail('appending past the budget must throw')
  } catch (error) {
    // append() wraps every failure as FAILED_TO_APPEND with the real cause.
    t.is(
      error.cause.code,
      model.constructor.ERR_CODES.BUFFER_LIMIT_EXCEEDED,
      'BUFFER_LIMIT_EXCEEDED (6015) is the cause'
    )
    t.ok(
      /s16le/.test(error.message),
      'the message names the source format the cap is denominated in'
    )
  }

  await model.destroy()
})
