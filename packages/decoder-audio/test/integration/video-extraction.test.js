'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const { AbortController } = require('bare-abort-controller')
const { VideoFrameDecoder } = require('../..')
const { createVideo, collectFrames } = require('../helpers/video-fixture')
const { rotateRgb } = require('../../video/rotation')

test('video extraction drains delayed frames at EOF and returns owned RGB', async (t) => {
  const input = createVideo({ fps: 5, frames: 20 })
  const decoder = new VideoFrameDecoder({ mode: 'uniform', fps: 5 })
  const frames = await collectFrames(decoder, input)
  t.is(frames.length, 20)
  t.is(decoder.runtimeStats.decodedFrames, 20)
  t.is(frames[19].ptsMs, 3800)
  t.is(frames[0].rgb.length, 64 * 48 * 3)
  t.not(frames[0].rgb[2], frames[19].rgb[2], 'earlier output was not overwritten')
})

test('video auto uses dense keyframes, falls back for sparse keyframes and covers the full clip', async (t) => {
  const dense = new VideoFrameDecoder({ maxFrames: 4 })
  const frames = await collectFrames(dense, createVideo({ bFrames: 0 }))
  t.is(dense.runtimeStats.info.samplingMode, 'keyframes')
  t.is(frames.length, 4)
  t.is(frames[3].ptsMs, 3000, 'budget spans the whole clip')
  t.is(dense.runtimeStats.decodedFrames, 8, 'skip_frame=nokey is actually enabled')
  const sparse = new VideoFrameDecoder()
  await collectFrames(sparse, createVideo({ gop: 30, bFrames: 0 }))
  t.is(sparse.runtimeStats.info.samplingMode, 'uniform')
  t.is(sparse.runtimeStats.decodedFrames, 40)
})

test('video path, offset bytes, seekable reader and chunk staging have identical output', async (t) => {
  const bytes = createVideo({ frames: 10 })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-video-test-'))
  const filename = path.join(directory, 'fixture.mp4')
  fs.writeFileSync(filename, bytes)
  try {
    const config = { mode: 'uniform', tempDirectory: directory }
    const expected = await collectFrames(new VideoFrameDecoder(config), bytes)
    const padded = Buffer.concat([Buffer.alloc(17), bytes, Buffer.alloc(5)])
    const inputs = [
      filename,
      padded.subarray(17, 17 + bytes.length),
      {
        size: bytes.length,
        read(offset, length) {
          return bytes.subarray(offset, offset + Math.min(length, 101))
        }
      },
      (async function* () {
        for (let i = 0; i < bytes.length; i += 127) {
          await Promise.resolve()
          yield bytes.subarray(i, i + 127)
        }
      })()
    ]
    for (const input of inputs) {
      t.alike(await collectFrames(new VideoFrameDecoder(config), input), expected)
    }
    t.alike(fs.readdirSync(directory), ['fixture.mp4'], 'private chunk staging was removed')
  } finally {
    fs.unlinkSync(filename)
    fs.rmdirSync(directory)
  }
})

test('video portrait matrices are applied to packed RGB pixels', async (t) => {
  const config = { mode: 'uniform', maxDimension: 32 }
  const plain = await collectFrames(new VideoFrameDecoder(config), createVideo({ frames: 10 }))
  for (const rotation of [90, 180, 270]) {
    const decoder = new VideoFrameDecoder(config)
    const frames = await collectFrames(decoder, createVideo({ frames: 10, rotation }))
    t.is(decoder.runtimeStats.info.rotation, rotation)
    t.alike(frames[0], {
      ...rotateRgb(plain[0].rgb, plain[0].width, plain[0].height, rotation),
      ptsMs: 0
    })
  }
})

test('video invalid input, limits, cancellation and early exit leave the decoder reusable', async (t) => {
  const bytes = createVideo()
  const decoder = new VideoFrameDecoder({ mode: 'uniform' })
  await t.exception(() => collectFrames(decoder, Buffer.from('not video')))
  await t.exception(() => collectFrames(new VideoFrameDecoder({ maxDurationS: 1 }), bytes))
  await t.exception(() => collectFrames(new VideoFrameDecoder({ maxOutputBytes: 1 }), bytes))
  const controller = new AbortController()
  const iterator = decoder.frames(bytes, { signal: controller.signal })
  await iterator.next()
  controller.abort()
  await t.exception(() => iterator.next(), /cancel/i)
  const early = decoder.frames(bytes)
  await early.next()
  await early.return()
  t.ok((await collectFrames(decoder, bytes)).length > 0)
})

test('video extraction selects video even when audio is the first stream', async (t) => {
  const config = { mode: 'uniform' }
  const expected = await collectFrames(new VideoFrameDecoder(config), createVideo())
  const actual = await collectFrames(new VideoFrameDecoder(config), createVideo({ audio: true }))
  t.alike(actual, expected, 'audio packets cannot be sent to the video decoder')
})

test('video staging cleans up on cancellation while the producer is stalled', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-video-test-'))
  try {
    const controller = new AbortController()
    let returned = false
    const input = {
      [Symbol.asyncIterator]() {
        return this
      },
      next() {
        return new Promise(() => {})
      },
      return() {
        returned = true
        return Promise.resolve({ done: true })
      }
    }
    const decoder = new VideoFrameDecoder({ tempDirectory: directory })
    const result = collectFrames(decoder, input, { signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    await t.exception(() => result, /cancel/i)
    t.alike(fs.readdirSync(directory), [], 'staged private bytes were removed')
    t.ok(returned, 'producer is asked to stop')
    const bytes = createVideo()
    const oversized = new VideoFrameDecoder({ tempDirectory: directory, maxInputBytes: 1 })
    await t.exception(() =>
      collectFrames(
        oversized,
        (async function* () {
          yield bytes
        })()
      )
    )
    t.alike(fs.readdirSync(directory), [], 'oversized staged input was removed')
    const failed = (async function* () {
      yield bytes
      throw new Error('producer failed')
    })()
    await t.exception(() => collectFrames(decoder, failed))
    t.alike(fs.readdirSync(directory), [], 'producer failure also cleans up')
  } finally {
    fs.rmdirSync(directory)
  }
})

test('video probe and reader failures are structured and cancellation yields during decode', async (t) => {
  const bytes = createVideo({ frames: 300, gop: 100 })
  const decoder = new VideoFrameDecoder({ mode: 'uniform', fps: 0.01 })
  const controller = new AbortController()
  const iterator = decoder.frames(bytes, { signal: controller.signal })
  await iterator.next()
  setTimeout(() => controller.abort(), 0)
  await t.exception(() => iterator.next(), /cancel/i, 'cancellation works between sampled frames')
  const info = await decoder.probe(bytes)
  t.is(info.durationMs, 30000)
  t.is(info.codec, 'mpeg4')
  await t.exception(() =>
    decoder.probe({
      size: 10,
      read() {
        return Buffer.alloc(0)
      }
    })
  )
  await t.exception(() => decoder.probe('qvac-nonexistent-video-input.mp4'))
  await t.exception(() =>
    collectFrames(decoder, {
      size: bytes.length,
      read() {
        return Buffer.alloc(bytes.length + 1)
      }
    })
  )
})
