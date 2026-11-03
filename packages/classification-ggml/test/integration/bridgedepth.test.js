'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const env = require('bare-env')
const { BridgeDepth } = require('../../index')
const { TEST_TIMEOUT } = require('./utils')

// Weights are not bundled: convert them (docs/bridgedepth.md) and set
// QVAC_BRIDGEDEPTH_MODEL_PATH. QVAC_BRIDGEDEPTH_BACKEND picks the device.
const modelPath = env.QVAC_BRIDGEDEPTH_MODEL_PATH || ''
const backend = env.QVAC_BRIDGEDEPTH_BACKEND || 'CPU'
const fixtures = path.join(__dirname, '..', 'fixtures')

function fixture(name) {
  return fs.readFileSync(path.join(fixtures, name))
}

function floats(name) {
  const bytes = fixture(name)
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

function within(result, reference, tolerance) {
  let count = 0
  for (let i = 0; i < result.length; i++) {
    if (Math.abs(result[i] - reference[i]) < tolerance) count++
  }
  return count / result.length
}

test('BridgeDepth validates options and missing weights', async function (t) {
  t.exception.all(() => new BridgeDepth({}), /modelPath is required/)
  t.exception.all(() => new BridgeDepth({ modelPath: 'x.gguf', threads: 0 }), /threads/)
  const model = new BridgeDepth({ modelPath: path.join(fixtures, 'missing-bridgedepth.gguf') })
  await t.exception.all(() => model.load(), /not found/)
  await t.exception.all(() => model.infer(new Uint8Array(3), new Uint8Array(3)), /not loaded/)
  await model.destroy()
  t.is(model.getState().destroyed, true)
})

test(
  'BridgeDepth matches the original PyTorch disparity on the fixture pair',
  { skip: !modelPath },
  async function (t) {
    t.timeout(TEST_TIMEOUT)
    const model = new BridgeDepth({ modelPath, backend, threads: 4 })
    try {
      await model.load()
      const left = fixture('bridgedepth-left.png')
      const right = fixture('bridgedepth-right.png')
      const result = await model.infer(left, right)
      t.is(result.width, 200)
      t.is(result.height, 100)
      t.ok(result.disparity instanceof Float32Array)
      const reference = floats('bridgedepth-disparity-f32.bin')
      const fraction = within(result.disparity, reference, 0.2)
      t.comment(
        `${backend}: ${fraction} within 0.2 px, stats=${JSON.stringify(model.getRuntimeStats())}`
      )
      // Top-k tie breaks in the DPN differ from torch on a few pixels.
      t.ok(fraction >= 0.95, 'matches the PyTorch disparity')
      const stats = model.getRuntimeStats()
      t.ok(stats.total_time_ms > 0)
      t.ok(stats.weight_bytes > 100000000)

      await t.exception.all(() => model.infer(left, new Uint8Array([1, 2, 3])), /JPEG\/PNG/)
      await t.exception.all(
        () =>
          model.infer(new Uint8Array(32 * 40 * 3), new Uint8Array(32 * 40 * 3), {
            width: 40,
            height: 32
          }),
        /width', 'height', and 'channels'/
      )
      const small = new Uint8Array(64 * 48 * 3).fill(100)
      await t.exception.all(
        () => model.infer(small, new Uint8Array(10), { width: 64, height: 48, channels: 3 }),
        /size|bytes|buffer/i
      )

      const raw = await model.infer(small, small, { width: 64, height: 48, channels: 3 })
      t.is(raw.disparity.length, 64 * 48)
      t.ok(raw.disparity.every(Number.isFinite), 'raw RGB input gives a finite map')
    } finally {
      await model.destroy()
    }
  }
)
