'use strict'

const process = require('process')
global.process = process

const test = require('brittle')
const sinon = require('sinon')

const ImgStableDiffusion = require('../../index.js')
const { SdInterface } = require('../../addon.js')
const MockedBinding = require('../mock/MockedBinding.js')
const { wait } = require('../mock/utils.js')

function createMockedModel ({ binding, onOutput, stats = false } = {}) {
  const fakeLoader = {
    ready: async () => {},
    close: async () => {},
    getStream: async () => (async function * () {})(),
    download: async () => ({ await: async () => {} }),
    getFileSize: async () => 0
  }

  const model = new ImgStableDiffusion(
    {
      loader: fakeLoader,
      logger: console,
      diskPath: '/tmp/fake-models',
      modelName: 'fake-model.gguf',
      opts: { stats }
    },
    { threads: 1 }
  )

  sinon.stub(model.weightsProvider, 'downloadFiles').resolves()

  sinon.stub(model, '_createAddon').callsFake((configurationParams) => {
    const _binding = binding || new MockedBinding()
    const addon = new SdInterface(
      _binding,
      configurationParams,
      model._addonOutputCallback.bind(model)
    )
    return addon
  })

  return model
}

async function collectImages (response) {
  const images = []
  const ticks = []
  await response
    .onUpdate(data => {
      if (data instanceof Uint8Array) {
        images.push(data)
      } else if (typeof data === 'string') {
        try { ticks.push(JSON.parse(data)) } catch (_) {}
      }
    })
    .await()
  return { images, ticks }
}

test('load/activate lifecycle completes without error', async (t) => {
  const model = createMockedModel()

  await model.load()
  t.pass('model.load() succeeded')

  await model.unload()
  t.pass('model.unload() succeeded')
})

test('txt2img produces PNG image output', async (t) => {
  const model = createMockedModel()
  await model.load()

  try {
    const response = await model.run({
      prompt: 'a test image',
      steps: 5,
      width: 512,
      height: 512,
      seed: 42
    })

    t.ok(response, 'run() returns a response')
    t.ok(typeof response.onUpdate === 'function', 'response has onUpdate')
    t.ok(typeof response.await === 'function', 'response has await')

    const { images } = await collectImages(response)

    t.ok(images.length > 0, 'received at least one image')
    t.ok(images[0] instanceof Uint8Array, 'image is a Uint8Array')
    t.ok(
      images[0][0] === 0x89 && images[0][1] === 0x50 &&
      images[0][2] === 0x4E && images[0][3] === 0x47,
      'image starts with PNG magic bytes'
    )
  } finally {
    await model.unload()
  }
})

test('progress ticks are emitted before the image', async (t) => {
  const model = createMockedModel()
  await model.load()

  try {
    const response = await model.run({
      prompt: 'a test image',
      steps: 5,
      width: 256,
      height: 256,
      seed: 1
    })

    const { ticks, images } = await collectImages(response)

    t.ok(ticks.length > 0, 'received progress ticks')
    t.ok(ticks[0].step === 1, 'first tick step is 1')
    t.ok(ticks[0].total === 5, 'first tick total matches steps param')
    t.ok(images.length > 0, 'received image after ticks')
  } finally {
    await model.unload()
  }
})

test('JobEnded fires with stats containing generation_time', async (t) => {
  const model = createMockedModel({ stats: true })
  await model.load()

  try {
    const response = await model.run({
      prompt: 'a test image',
      steps: 3,
      width: 256,
      height: 256,
      seed: 1
    })

    await collectImages(response)

    t.ok(response.stats, 'response has stats')
    t.ok('generation_time' in response.stats, 'stats contains generation_time')
  } finally {
    await model.unload()
  }
})

test('concurrent run() throws busy error', async (t) => {
  const hangingBinding = new MockedBinding()
  const origRunJob = hangingBinding.runJob.bind(hangingBinding)
  hangingBinding.runJob = function (handle, data) {
    // Override to hang: start the job but never emit JobEnded
    if (handle !== this._handle) throw new Error('Invalid handle')
    this._running = true
    this._cancelled = false
    return true
  }

  const model = createMockedModel({ binding: hangingBinding })
  await model.load()

  try {
    const firstResponse = await model.run({
      prompt: 'first image',
      steps: 5,
      width: 256,
      height: 256,
      seed: 1
    })

    await t.exception(
      async () => {
        await model.run({
          prompt: 'second image',
          steps: 5,
          width: 256,
          height: 256,
          seed: 2
        })
      },
      /already set or being processed/,
      'second run() throws busy error'
    )

    firstResponse.failed(new Error('test cleanup'))
  } finally {
    await model.unload().catch(() => {})
  }
})

test('cancel during generation stops cleanly', async (t) => {
  const model = createMockedModel()
  await model.load()

  try {
    const response = await model.run({
      prompt: 'a test image',
      steps: 100,
      width: 256,
      height: 256,
      seed: 1
    })

    await model.cancel()
    t.pass('cancel() resolved without error')

    try {
      await response.await()
    } catch (_) {}
    t.pass('response settled after cancel')
  } finally {
    await model.unload()
  }
})

test('unload is idempotent', async (t) => {
  const model = createMockedModel()
  await model.load()

  await model.unload()
  t.pass('first unload succeeded')

  await model.unload()
  t.pass('second unload succeeded (idempotent)')
})

test('img2img throws when init_image is missing', async (t) => {
  const model = createMockedModel()
  await model.load()

  try {
    await t.exception(
      async () => {
        await model.img2img({ prompt: 'test' })
      },
      /init_image/,
      'img2img throws without init_image'
    )
  } finally {
    await model.unload()
  }
})

test('batch_count > 1 produces multiple images', async (t) => {
  const model = createMockedModel()
  await model.load()

  try {
    const response = await model.run({
      prompt: 'a test image',
      steps: 3,
      width: 256,
      height: 256,
      seed: 1,
      batch_count: 3
    })

    const { images } = await collectImages(response)
    t.ok(images.length === 3, `received 3 images (got ${images.length})`)
  } finally {
    await model.unload()
  }
})

test('cancel when idle is a no-op', async (t) => {
  const model = createMockedModel()
  await model.load()

  try {
    await model.cancel()
    t.pass('cancel when idle does not throw')
  } finally {
    await model.unload()
  }
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
