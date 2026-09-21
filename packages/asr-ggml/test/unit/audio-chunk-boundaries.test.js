'use strict'

// Byte-length validation is an AGGREGATE property of a byte stream, not a
// per-chunk one. A caller pumping raw PCM from a socket, pipe or file read has
// no control over chunk sizes, so a single sample can straddle a boundary
// (1023 bytes then 1025). The pre-merge whisper package concatenated every
// chunk of a batch and let the native decoder validate the merged buffer once,
// so that split was harmless; normalization now happens per chunk in JS, so
// the trailing partial sample is carried over instead of rejected. Only a
// stream that ENDS mid-sample is invalid.

const test = require('brittle')
const ASRGgml = require('../../index.js')
const { normalizeAudioStream, createChunkNormalizer } = require('../../lib/audio.js')
const { MODEL_PATH } = require('../mocks/createModel.js')

const process = require('bare-process')
global.process = process

async function drain(stream) {
  const out = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

function s16Bytes(samples) {
  return new Uint8Array(new Int16Array(samples).buffer)
}

test('a sample split across two byte chunks is reassembled, not rejected', async (t) => {
  const bytes = s16Bytes([1000, -1000, 32767, -32768])
  // Split mid-sample: 3 bytes then 5 bytes.
  const chunks = [bytes.subarray(0, 3), bytes.subarray(3)]

  const samples = await drain(
    normalizeAudioStream(
      {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c
        }
      },
      's16le'
    )
  )

  const flat = []
  for (const s of samples) flat.push(...s)
  t.is(flat.length, 4, 'all four samples survive the odd split')
  t.alike(
    flat.map((v) => Math.round(v * 32768)),
    [1000, -1000, 32767, -32768],
    'and they carry the right values in the right order'
  )
})

test('odd-sized chunks over many boundaries preserve the whole stream', async (t) => {
  const total = 1023 + 1025
  const bytes = new Uint8Array(total)
  for (let i = 0; i < total; i++) bytes[i] = i & 0xff

  const samples = await drain(
    normalizeAudioStream(
      {
        async *[Symbol.asyncIterator]() {
          yield bytes.subarray(0, 1023)
          yield bytes.subarray(1023)
        }
      },
      's16le'
    )
  )

  const count = samples.reduce((n, s) => n + s.length, 0)
  t.is(count, total / 2, `${total} bytes yield ${total / 2} s16 samples across chunk boundaries`)
})

test('a byte stream that ends mid-sample still raises INVALID_AUDIO_INPUT', async (t) => {
  try {
    await drain(
      normalizeAudioStream(
        {
          async *[Symbol.asyncIterator]() {
            yield new Uint8Array([1, 2, 3])
          }
        },
        's16le'
      )
    )
    t.fail('a stream ending mid-sample must be rejected')
  } catch (error) {
    t.is(error.code, ASRGgml.ERR_CODES.INVALID_AUDIO_INPUT, 'INVALID_AUDIO_INPUT (6011)')
    t.ok(/mid-sample/.test(error.message), 'the message says where the problem is')
  }
})

test('materialized chunk arrays are validated in aggregate too', (t) => {
  const bytes = s16Bytes([7, 8])
  const out = normalizeAudioStream([bytes.subarray(0, 1), bytes.subarray(1)], 's16le')
  const count = out.reduce((n, s) => n + s.length, 0)
  t.is(count, 2, 'an array of chunks splitting a sample is joined, not rejected')

  t.exception(
    () => normalizeAudioStream([new Uint8Array([1, 2, 3])], 's16le'),
    'an array whose total is not a whole number of samples still throws'
  )
})

test('carried-over bytes are copied, so caller buffer reuse is safe', (t) => {
  const normalizer = createChunkNormalizer('s16le')
  const scratch = new Uint8Array([0x10])
  t.is(normalizer.push(scratch).length, 0, 'a lone odd byte yields no samples yet')
  scratch[0] = 0x00 // the caller reuses its buffer

  const out = normalizer.push(new Uint8Array([0x20]))
  t.is(out.length, 1, 'the next chunk completes the sample')
  t.is(Math.round(out[0] * 32768), 0x2010, 'the carried byte kept its original value')
  normalizer.flush()
})

test('f32le byte streams carry over partial samples the same way', async (t) => {
  const bytes = new Uint8Array(new Float32Array([0.5, -0.25]).buffer)
  const samples = await drain(
    normalizeAudioStream(
      {
        async *[Symbol.asyncIterator]() {
          yield bytes.subarray(0, 2)
          yield bytes.subarray(2, 7)
          yield bytes.subarray(7)
        }
      },
      'f32le'
    )
  )
  const flat = []
  for (const s of samples) flat.push(...s)
  t.alike(flat, [0.5, -0.25], 'both f32 samples survive three ragged chunks')
})

test('whisper rejects an unrecognized audio_format instead of coercing it', (t) => {
  // The wire format handed to native is pinned to f32le, so the native
  // UnsupportedAudioFormat check can no longer see the caller's string:
  // silently decoding 's16be' as little-endian would produce a garbage
  // transcript with no error at all.
  for (const audioFormat of ['s16be', 'f32', 'float32', 'pcm16']) {
    try {
      // eslint-disable-next-line no-new
      new ASRGgml({
        files: { model: MODEL_PATH },
        config: { engine: 'whisper', whisperConfig: { audio_format: audioFormat } }
      })
      t.fail(`${audioFormat} should not be accepted`)
    } catch (error) {
      t.is(
        error.code,
        ASRGgml.ERR_CODES.INVALID_AUDIO_FORMAT,
        `${audioFormat} throws INVALID_AUDIO_FORMAT (24010)`
      )
    }
  }

  for (const audioFormat of ['s16le', 'f32le', 'decoded']) {
    const model = new ASRGgml({
      files: { model: MODEL_PATH },
      config: { engine: 'whisper', whisperConfig: { audio_format: audioFormat } }
    })
    t.ok(model, `${audioFormat} is accepted`)
  }
})
