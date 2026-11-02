'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const env = require('bare-env')
const process = require('bare-process')
const { MegaLoc } = require('../../index')
const references = require('../fixtures/megaloc-reference.json')
const { isMobile, TEST_TIMEOUT, makeClassifier, loadImage, resolveModelPath } = require('./utils')

function asset(filename, modelEnv) {
  if (modelEnv && env[modelEnv]) return env[modelEnv]
  if (isMobile && global.assetPaths) {
    const suffix = filename.endsWith('.gguf') ? filename + '.bin' : filename
    for (const key of Object.keys(global.assetPaths)) {
      if (key.endsWith('/' + suffix)) return global.assetPaths[key].replace(/^file:\/\//, '')
    }
  }
  const local = path.join(__dirname, '..', 'fixtures', filename)
  if (fs.existsSync(local)) return local
  throw new Error(
    `Required MegaLoc test asset missing: ${filename}${modelEnv ? ` (${modelEnv})` : ''}. ` +
      'Convert both models before testing; see docs/megaloc.md.'
  )
}

function makeModel(quant) {
  const variable = `QVAC_MEGALOC_${quant.toUpperCase()}_MODEL_PATH`
  return new MegaLoc({
    modelPath: asset(`megaloc-${quant}.gguf`, variable),
    backend: env.QVAC_MEGALOC_BACKEND || 'CPU',
    threads: 8
  })
}

function image(width, height) {
  const data = new Uint8Array(width * height * 3)
  for (let i = 0; i < data.length; i++) data[i] = (i * 37 + Math.floor(i / 19)) % 256
  return data
}

function cosine(a, b) {
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return dot / Math.sqrt(aa * bb)
}

function descriptor(t, value) {
  t.ok(value instanceof Float32Array)
  t.is(value.length, 8448)
  let norm = 0
  for (const component of value) {
    if (!Number.isFinite(component)) t.fail('non-finite descriptor component')
    norm += component * component
  }
  t.ok(Math.abs(norm - 1) < 1e-4, 'descriptor has unit L2 norm')
}

for (const quant of ['f16', 'mixed']) {
  test(`MegaLoc ${quant}: original PyTorch parity, repeatability and lifecycle`, async function (t) {
    t.timeout(TEST_TIMEOUT)
    const model = makeModel(quant)
    try {
      await model.load()
      await model.load()
      for (const reference of references.cases) {
        const pixels = image(reference.width, reference.height)
        const options = { width: reference.width, height: reference.height, channels: 3 }
        const result = await model.embed(pixels, options)
        descriptor(t, result)
        const bytes = fs.readFileSync(asset(reference.reference))
        const baseline = new Float32Array(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        )
        const similarity = cosine(result, baseline)
        t.comment(
          `${quant} ${reference.name}: cosine=${similarity}, stats=${JSON.stringify(model.getRuntimeStats())}`
        )
        t.ok(
          similarity >= (quant === 'f16' ? 0.9999 : 0.9995),
          'matches original PyTorch descriptor'
        )
        const again = await model.embed(pixels, options)
        let maxError = 0
        for (let i = 0; i < result.length; i++) {
          maxError = Math.max(maxError, Math.abs(result[i] - again[i]))
        }
        t.ok(maxError < 1e-6, 'repeated execution refreshes scheduler constants')
      }
      const stats = model.getRuntimeStats()
      t.ok(stats.total_time_ms > 0)
      t.ok(stats.weight_bytes > 0)
      const backend = env.QVAC_MEGALOC_BACKEND || 'CPU'
      const expected = backend.startsWith('CUDA')
        ? 2
        : backend.startsWith('Vulkan')
          ? 3
          : backend.startsWith('Metal') || backend.startsWith('MTL')
            ? 1
            : backend.startsWith('OpenCL') || backend.startsWith('GPUOpenCL')
              ? 4
              : 0
      t.is(stats.backend_id, expected, 'requested backend is used')
      await model.unload()
      await model.unload()
      await t.exception.all(() => model.embed(new Uint8Array()), /not loaded/i)
      await model.load()
      descriptor(t, await model.embed(image(64, 48), { width: 64, height: 48, channels: 3 }))
    } finally {
      await model.destroy()
    }
    t.is(model.getState().destroyed, true)
    await t.exception.all(() => model.load(), /destroyed/i)
  })
}

for (const quant of ['f16', 'mixed']) {
  test(`MegaLoc ${quant}: automatic backend matches original PyTorch without blocking load`, async function (t) {
    t.timeout(TEST_TIMEOUT)
    const model = new MegaLoc({
      modelPath: asset(`megaloc-${quant}.gguf`, `QVAC_MEGALOC_${quant.toUpperCase()}_MODEL_PATH`)
    })
    let ticks = 0
    const timer = setInterval(() => ticks++, 1)
    try {
      await model.load()
      clearInterval(timer)
      t.ok(ticks > 0, 'event loop runs while native weights and graph load')
      for (const reference of references.cases) {
        const result = await model.embed(image(reference.width, reference.height), {
          width: reference.width,
          height: reference.height,
          channels: 3
        })
        descriptor(t, result)
        const bytes = fs.readFileSync(asset(reference.reference))
        const baseline = new Float32Array(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        )
        const similarity = cosine(result, baseline)
        t.comment(
          `automatic ${quant} ${reference.name}: cosine=${similarity}, stats=${JSON.stringify(model.getRuntimeStats())}`
        )
        t.ok(similarity >= (quant === 'f16' ? 0.9999 : 0.9995), 'automatic backend matches PyTorch')
      }
      const backend = model.getRuntimeStats().backend_id
      t.ok([0, 1, 2, 3, 4].includes(backend), 'automatic selection reports a known backend')
      if (env.QVAC_MEGALOC_EXPECT_GPU === '1') t.not(backend, 0, 'GPU runner executes GPU parity')
      if (process.platform === 'darwin' || process.platform === 'ios') {
        t.is(backend, 1, 'Apple automatic selection uses Metal')
        await model.unload()
        for (const name of ['Metal', 'Metal0', 'MTL0']) {
          const metal = new MegaLoc({
            modelPath: asset(
              `megaloc-${quant}.gguf`,
              `QVAC_MEGALOC_${quant.toUpperCase()}_MODEL_PATH`
            ),
            backend: name
          })
          try {
            await metal.load()
            descriptor(t, await metal.embed(image(64, 48), { width: 64, height: 48, channels: 3 }))
            t.is(metal.getRuntimeStats().backend_id, 1, `${name} selects Metal`)
          } finally {
            await metal.destroy()
          }
        }
      }
    } finally {
      clearInterval(timer)
      await model.destroy()
    }
  })
}

test('MegaLoc serializes unload queued during native loading', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const model = makeModel('mixed')
  try {
    const loading = model.load()
    const unloading = model.unload()
    await Promise.all([loading, unloading])
    t.is(model.getState().configLoaded, false)
    await t.exception.all(
      () => model.embed(image(1, 1), { width: 1, height: 1, channels: 3 }),
      /not loaded/i
    )
    await model.load()
    descriptor(t, await model.embed(image(1, 1), { width: 1, height: 1, channels: 3 }))
  } finally {
    await model.destroy()
  }
})

test('MegaLoc: PNG decoding equals raw RGB preprocessing', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const model = makeModel('f16')
  try {
    await model.load()
    const encoded = await model.embed(fs.readFileSync(asset('megaloc-input.png')))
    const raw = await model.embed(image(64, 48), { width: 64, height: 48, channels: 3 })
    t.ok(cosine(encoded, raw) > 0.9999999)
    descriptor(t, await model.embed(loadImage('meal_1.jpg')))
  } finally {
    await model.destroy()
  }
})

test('MegaLoc: invalid input rejects and a later job still succeeds', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const model = makeModel('f16')
  try {
    await model.load()
    await t.exception.all(() => model.embed(null), /required|null|undefined/i)
    await t.exception.all(() => model.embed(new Uint8Array()), /empty/i)
    await t.exception.all(() => model.embed(new Uint8Array(12)), /jpeg|png|rgb/i)
    await t.exception.all(
      () => model.embed(new Uint8Array(12), { width: 2, height: 3, channels: 3 }),
      /size|dimensions/i
    )
    await t.exception.all(() => model.embed(new Uint8Array(12), { width: 2 }), /together/i)
    await t.exception.all(
      () => model.embed(new Uint8Array(12), { width: 0, height: 2, channels: 3 }),
      /positive/i
    )
    for (const width of [1.5, NaN, Infinity, 4294967297]) {
      await t.exception.all(
        () => model.embed(new Uint8Array(12), { width, height: 2, channels: 3 }),
        /positive integer/i
      )
    }
    descriptor(t, await model.embed(image(64, 48), { width: 64, height: 48, channels: 3 }))
  } finally {
    await model.destroy()
  }
})

test('MegaLoc and MobileNet coexist with independent jobs and lifetimes', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const model = makeModel('mixed')
  const classifier = makeClassifier()
  try {
    await classifier.load()
    await model.load()
    const [classes, embedding] = await Promise.all([
      classifier.classify(loadImage('meal_1.jpg')),
      model.embed(image(64, 48), { width: 64, height: 48, channels: 3 })
    ])
    t.is(classes[0].label, 'food')
    descriptor(t, embedding)
    await model.destroy()
    t.is((await classifier.classify(loadImage('report_1.jpg')))[0].label, 'report')
  } finally {
    await model.destroy()
    await classifier.destroy()
  }
})

test('MegaLoc rejects unavailable backends and incompatible model weights', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const unavailable = new MegaLoc({
    modelPath: asset('megaloc-f16.gguf', 'QVAC_MEGALOC_F16_MODEL_PATH'),
    backend: 'NoSuchMegaLocBackend'
  })
  const wrongModel = new MegaLoc({ modelPath: resolveModelPath(), backend: 'CPU' })
  const automatic = new MegaLoc({
    modelPath: asset('megaloc-f16.gguf', 'QVAC_MEGALOC_F16_MODEL_PATH')
  })
  try {
    await t.exception.all(() => unavailable.load(), /backend is unavailable/i)
    t.is(unavailable.getState().configLoaded, false)
    await t.exception.all(() => wrongModel.load(), /megaloc architecture/i)
    t.is(wrongModel.getState().configLoaded, false)
    await automatic.load()
    descriptor(t, await automatic.embed(image(64, 48), { width: 64, height: 48, channels: 3 }))
    t.ok(
      Number.isInteger(automatic.getRuntimeStats().backend_id),
      'automatic backend selection succeeds'
    )
  } finally {
    await unavailable.destroy()
    await wrongModel.destroy()
    await automatic.destroy()
  }
})
