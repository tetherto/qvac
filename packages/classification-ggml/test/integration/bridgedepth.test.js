'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const env = require('bare-env')
const { BridgeDepth } = require('../../index')
const { isMobile, platform, TEST_TIMEOUT } = require('./utils')

// Weights are not bundled: convert them (docs/bridgedepth.md) into
// test/fixtures/bridgedepth-vits-f32.gguf or set QVAC_BRIDGEDEPTH_MODEL_PATH.
// Without a model the parity test is skipped on desktop and fails on mobile.
// QVAC_BRIDGEDEPTH_BACKEND picks the device. On GPU runners CI sets
// QVAC_BRIDGEDEPTH_EXPECT_GPU=1 instead, which uses automatic selection and
// requires a GPU.
const expectGpu = env.QVAC_BRIDGEDEPTH_EXPECT_GPU === '1'
const backend = env.QVAC_BRIDGEDEPTH_BACKEND || (expectGpu ? undefined : 'CPU')
const fixtures = path.join(__dirname, '..', 'fixtures')
// backend_id in runtime stats, see GgmlBackend.hpp.
const BACKEND_ID = { CPU: 0, METAL: 1, CUDA: 2, VULKAN: 3, OPENCL: 4 }
// Set by the mobile automatic selection test.
let mobileAutoBackend

function asset(filename, modelEnv) {
  if (modelEnv && env[modelEnv]) return env[modelEnv]
  if (isMobile && global.assetPaths) {
    const suffix = filename.endsWith('.gguf') ? filename + '.bin' : filename
    for (const key of Object.keys(global.assetPaths)) {
      if (key.endsWith('/' + suffix)) return global.assetPaths[key].replace(/^file:\/\//, '')
    }
  }
  const local = path.join(fixtures, filename)
  return fs.existsSync(local) ? local : ''
}

// Desktop CI stages the model through reusable-test-models-classification-ggml.yml
// and verifies its checksum, so a missing model only skips local runs. Mobile
// gets it from copy-mobile-test-assets.js, where a missing or mis-keyed asset
// would otherwise pass as a skip.
const modelPath = asset('bridgedepth-vits-f32.gguf', 'QVAC_BRIDGEDEPTH_MODEL_PATH')

function fixture(name) {
  return fs.readFileSync(asset(name))
}

function floats(name) {
  const bytes = fixture(name)
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

// A pair wider than the 1280x720 box the model runs at, see docs/bridgedepth.md.
// A narrow height keeps the run cheap; the shift is a few pixels of disparity.
const WIDE_WIDTH = 1600
const WIDE_HEIGHT = 64
const WIDE_SHIFT = 4

// Packed RGB stripes; the right view is the left shifted by `shift` pixels.
// The periods are coprime primes so the pattern does not repeat in a small
// window, and `level` spreads the values over the 0..255 range.
function texture(width, height, shift) {
  const xPeriod = 37
  const yPeriod = 23
  const level = 7
  const rgb = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        rgb[(y * width + x) * 3 + c] = ((((x + shift) % xPeriod) + (y % yPeriod) + c) * level) % 256
      }
    }
  }
  return rgb
}

function maxAbsDiff(a, b) {
  let max = 0
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]))
  return max
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

// Parity, error paths and repeated inference on one backend. `selected` is a
// backend name, or undefined for automatic selection; `check` gets the runtime
// stats to assert which backend ran.
async function checkParity(t, selected, check) {
  const model = new BridgeDepth({ modelPath, backend: selected, threads: 4 })
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
      `${selected || 'auto'}: ${fraction} within 0.2 px, stats=${JSON.stringify(model.getRuntimeStats())}`
    )
    // Top-k tie breaks in the DPN differ from torch on a few pixels. Measured
    // on the fixture: CPU, CUDA and Vulkan 99.8%, Metal 99.79%.
    t.ok(fraction >= 0.99, 'matches the PyTorch disparity')
    const stats = model.getRuntimeStats()
    t.ok(stats.total_time_ms > 0)
    t.ok(stats.weight_bytes > 100000000)
    check(stats)
    // A GPU op that falls back to the CPU keeps the result right and only
    // costs speed, so parity alone misses it. OpenCL lacks ops this graph
    // needs and is left out.
    if ([BACKEND_ID.METAL, BACKEND_ID.CUDA, BACKEND_ID.VULKAN].includes(stats.backend_id)) {
      t.is(stats.cpu_fallback_nodes, 0, 'whole graph runs on the GPU')
    }

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

    // Wider than 1280, so it runs downsampled to 1280x51 and the disparity
    // comes back at the input size. A short pair keeps the run cheap on mobile.
    const wide = { width: WIDE_WIDTH, height: WIDE_HEIGHT, channels: 3 }
    const wideLeft = texture(wide.width, wide.height, 0)
    const wideRight = texture(wide.width, wide.height, WIDE_SHIFT)
    const resized = await model.infer(wideLeft, wideRight, wide)
    t.is(resized.width, wide.width, 'downsampled run returns the input width')
    t.is(resized.height, wide.height, 'downsampled run returns the input height')
    t.is(resized.disparity.length, wide.width * wide.height)
    t.ok(resized.disparity.every(Number.isFinite), 'downsampled run gives a finite map')

    // Calls at other sizes in between must not change the fixture result.
    const again = await model.infer(left, right)
    t.ok(maxAbsDiff(again.disparity, result.disparity) < 1e-3, 'same result after other sizes')
  } finally {
    await model.destroy()
  }
}

// The default path apps get on mobile: automatic selection of the device GPU.
// Runs before the CPU test so that one can skip when this already ran on the CPU.
test(
  'BridgeDepth matches the PyTorch disparity with automatic backend selection on mobile',
  { skip: !isMobile },
  async function (t) {
    t.timeout(TEST_TIMEOUT)
    if (!modelPath) {
      t.fail('BridgeDepth test model missing from the mobile test assets')
      return
    }
    await checkParity(t, undefined, (stats) => {
      mobileAutoBackend = stats.backend_id
      if (platform === 'ios') {
        t.is(stats.backend_id, BACKEND_ID.METAL, 'iOS automatic selection uses Metal')
      } else {
        t.ok(
          Object.values(BACKEND_ID).includes(stats.backend_id),
          'automatic selection reports a known backend'
        )
      }
    })
  }
)

test(
  'BridgeDepth matches the original PyTorch disparity on the fixture pair',
  { skip: !modelPath && !isMobile },
  async function (t) {
    t.timeout(TEST_TIMEOUT)
    if (!modelPath) {
      t.fail('BridgeDepth test model missing from the mobile test assets')
      return
    }
    // No override is set on mobile, so this test is the forced CPU run there.
    if (mobileAutoBackend === BACKEND_ID.CPU) {
      t.pass('automatic selection already ran the CPU parity checks')
      return
    }
    await checkParity(t, backend, (stats) => {
      if (expectGpu) t.not(stats.backend_id, BACKEND_ID.CPU, 'GPU runner runs on the GPU')
    })
  }
)
