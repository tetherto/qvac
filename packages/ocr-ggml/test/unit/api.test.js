'use strict'

const test = require('brittle')
const OcrGgml = require('../..').OcrGgml
const { ERR_CODES, QvacErrorAddonOcrGgml } = require('../..')

async function captureRejection(fn) {
  try {
    await fn()
  } catch (err) {
    return err
  }
  return null
}

test('OcrGgml constructor exposes initial state', (t) => {
  const ocr = new OcrGgml({
    params: {
      pathDetector: 'unused',
      pathRecognizer: 'unused',
      langList: ['en']
    }
  })

  t.alike(ocr.getState(), {
    configLoaded: false,
    weightsLoaded: false,
    destroyed: false
  })
})

test('OcrGgml.load rejects when pathDetector is missing', async (t) => {
  const ocr = new OcrGgml({
    params: {
      pathRecognizer: '/tmp/recognizer.gguf',
      langList: ['en']
    }
  })

  const err = await captureRejection(() => ocr.load())
  t.ok(err, 'load() rejected')
  t.ok(err instanceof QvacErrorAddonOcrGgml, 'rejection is a QvacErrorAddonOcrGgml')
  t.is(
    err && err.code,
    ERR_CODES.MISSING_REQUIRED_PARAMETER,
    'error.code is MISSING_REQUIRED_PARAMETER'
  )
})

test('OcrGgml.load rejects when pathRecognizer is missing', async (t) => {
  const ocr = new OcrGgml({
    params: {
      pathDetector: '/tmp/detector.gguf',
      langList: ['en']
    }
  })

  const err = await captureRejection(() => ocr.load())
  t.ok(err, 'load() rejected')
  t.ok(err instanceof QvacErrorAddonOcrGgml, 'rejection is a QvacErrorAddonOcrGgml')
  t.is(
    err && err.code,
    ERR_CODES.MISSING_REQUIRED_PARAMETER,
    'error.code is MISSING_REQUIRED_PARAMETER'
  )
})

test('OcrGgml.load rejects when langList is empty', async (t) => {
  const ocr = new OcrGgml({
    params: {
      pathDetector: '/tmp/detector.gguf',
      pathRecognizer: '/tmp/recognizer.gguf',
      langList: []
    }
  })

  const err = await captureRejection(() => ocr.load())
  t.ok(err, 'load() rejected')
  t.ok(err instanceof QvacErrorAddonOcrGgml, 'rejection is a QvacErrorAddonOcrGgml')
  t.is(
    err && err.code,
    ERR_CODES.MISSING_REQUIRED_PARAMETER,
    'error.code is MISSING_REQUIRED_PARAMETER'
  )
})

test('OcrGgml.getModelKey returns deterministic key', (t) => {
  t.is(OcrGgml.getModelKey(), 'ocr-ggml')
})

function fakeAddon(overrides = {}) {
  return {
    activate: async () => {},
    getBackendInfo: () => null,
    destroy: async () => {},
    cancel: async () => {},
    ...overrides
  }
}

test('OcrGgml.load defers language validation to the native pipeline', async (t) => {
  const created = []
  const ocr = new OcrGgml({
    params: {
      pathDetector: 'unused',
      pathRecognizer: 'unused',
      langList: ['fr']
    }
  })
  ocr._createAddon = (configurationParams) => {
    created.push(configurationParams)
    return fakeAddon()
  }

  await ocr.load()

  t.is(created.length, 1, 'addon was created')
  t.alike(created[0].langList, ['fr'], 'Latin-only langList is forwarded unmodified')
  t.alike(ocr.getState(), {
    configLoaded: true,
    weightsLoaded: true,
    destroyed: false
  })

  await ocr.unload()
})

test('OcrGgml.load allows omitting langList for the doctr pipeline', async (t) => {
  const created = []
  const ocr = new OcrGgml({
    params: {
      pathDetector: 'unused',
      pathRecognizer: 'unused',
      pipelineType: 'doctr'
    }
  })
  ocr._createAddon = (configurationParams) => {
    created.push(configurationParams)
    return fakeAddon()
  }

  await ocr.load()

  t.is(created.length, 1, 'addon was created')
  t.alike(
    created[0].langList,
    ['en'],
    'internal placeholder langList is forwarded to the native addon'
  )
  t.alike(ocr.getState(), {
    configLoaded: true,
    weightsLoaded: true,
    destroyed: false
  })

  await ocr.unload()
})

test('OcrGgml.load forwards an explicit doctr langList unmodified', async (t) => {
  const created = []
  const ocr = new OcrGgml({
    params: {
      pathDetector: 'unused',
      pathRecognizer: 'unused',
      pipelineType: 'doctr',
      langList: ['de']
    }
  })
  ocr._createAddon = (configurationParams) => {
    created.push(configurationParams)
    return fakeAddon()
  }

  await ocr.load()
  t.alike(created[0].langList, ['de'])
  await ocr.unload()
})

test('OcrGgml.load still requires langList for the easyocr pipeline', async (t) => {
  const ocr = new OcrGgml({
    params: {
      pathDetector: '/tmp/detector.gguf',
      pathRecognizer: '/tmp/recognizer.gguf'
    }
  })

  const err = await captureRejection(() => ocr.load())
  t.ok(err, 'load() rejected')
  t.ok(err instanceof QvacErrorAddonOcrGgml, 'rejection is a QvacErrorAddonOcrGgml')
  t.is(
    err && err.code,
    ERR_CODES.MISSING_REQUIRED_PARAMETER,
    'error.code is MISSING_REQUIRED_PARAMETER'
  )
})

test('OcrGgml.load rejects an explicit empty langList for the doctr pipeline', async (t) => {
  const ocr = new OcrGgml({
    params: {
      pathDetector: '/tmp/detector.gguf',
      pathRecognizer: '/tmp/recognizer.gguf',
      pipelineType: 'doctr',
      langList: []
    }
  })

  const err = await captureRejection(() => ocr.load())
  t.ok(err, 'load() rejected')
  t.is(
    err && err.code,
    ERR_CODES.MISSING_REQUIRED_PARAMETER,
    'error.code is MISSING_REQUIRED_PARAMETER'
  )
})

test('OcrGgml.load maps native language failures to UNSUPPORTED_LANGUAGE', async (t) => {
  const ocr = new OcrGgml({
    params: {
      pathDetector: 'unused',
      pathRecognizer: 'unused',
      langList: ['en']
    }
  })
  ocr._createAddon = () => {
    throw new Error('Received unsupported languages for the OCR addon: [xx]')
  }

  const err = await captureRejection(() => ocr.load())
  t.ok(err instanceof QvacErrorAddonOcrGgml, 'rejection is a QvacErrorAddonOcrGgml')
  t.is(err && err.code, ERR_CODES.UNSUPPORTED_LANGUAGE, 'error.code is UNSUPPORTED_LANGUAGE')
  t.ok(String(err && err.message).includes('unsupported languages'), 'native message is preserved')
  t.is(ocr.addon, null, 'no addon handle is retained')
})

test('OcrGgml.load maps language-compatibility failures to UNSUPPORTED_LANGUAGE', async (t) => {
  const ocr = new OcrGgml({
    params: {
      pathDetector: 'unused',
      pathRecognizer: 'unused',
      langList: ['th', 'fr']
    }
  })
  ocr._createAddon = () => {
    throw new Error('Thai is only compatible with English, try langList=["th","en"]')
  }

  const err = await captureRejection(() => ocr.load())
  t.is(err && err.code, ERR_CODES.UNSUPPORTED_LANGUAGE, 'error.code is UNSUPPORTED_LANGUAGE')
})

test('OcrGgml.load wraps other native creation failures as FAILED_TO_LOAD_WEIGHTS', async (t) => {
  const ocr = new OcrGgml({
    params: {
      pathDetector: 'unused',
      pathRecognizer: 'unused',
      langList: ['en']
    }
  })
  ocr._createAddon = () => {
    throw new Error('gguf_init_from_file: failed to open GGUF file')
  }

  const err = await captureRejection(() => ocr.load())
  t.ok(err instanceof QvacErrorAddonOcrGgml, 'rejection is a QvacErrorAddonOcrGgml')
  t.is(err && err.code, ERR_CODES.FAILED_TO_LOAD_WEIGHTS, 'error.code is FAILED_TO_LOAD_WEIGHTS')
  t.ok(String(err && err.message).includes('failed to open'), 'native message is preserved')
  t.is(ocr.addon, null, 'no addon handle is retained')
})

test('OcrGgml.load destroys the addon when activation fails', async (t) => {
  let destroyed = 0
  const ocr = new OcrGgml({
    params: {
      pathDetector: 'unused',
      pathRecognizer: 'unused',
      langList: ['en']
    }
  })
  ocr._createAddon = () =>
    fakeAddon({
      activate: async () => {
        throw new Error('activation boom')
      },
      destroy: async () => {
        destroyed++
      }
    })

  const err = await captureRejection(() => ocr.load())
  t.ok(err, 'load() rejected')
  t.is(err && err.message, 'activation boom', 'the activation error propagates')
  t.is(destroyed, 1, 'the failed addon instance was destroyed')
  t.is(ocr.addon, null, 'no addon handle is retained')
  t.alike(ocr.getState(), {
    configLoaded: false,
    weightsLoaded: false,
    destroyed: false
  })
})

test('OcrGgml.load surfaces the activation error even when cleanup fails', async (t) => {
  const ocr = new OcrGgml({
    params: {
      pathDetector: 'unused',
      pathRecognizer: 'unused',
      langList: ['en']
    }
  })
  ocr._createAddon = () =>
    fakeAddon({
      activate: async () => {
        throw new Error('activation boom')
      },
      destroy: async () => {
        throw new Error('destroy boom')
      }
    })

  const err = await captureRejection(() => ocr.load())
  t.is(err && err.message, 'activation boom', 'the original activation error wins')
  t.is(ocr.addon, null, 'no addon handle is retained')
})
