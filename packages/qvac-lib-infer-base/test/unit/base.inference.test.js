'use strict'

const test = require('brittle')
const BaseInference = require('../..')
const WeightsProviderBaseInference = require('../../WeightsProvider/BaseInference')
const { ERR_CODES } = require('../../src/error')

const platformDefinitions = {
  android: 'vulkan',
  darwin: 'metal',
  ios: 'metal',
  win32: 'vulkan-32',
  linux: 'vulkan'
}

test('BaseInference - getApiDefinition returns correct platform definition', async t => {
  const inference = new BaseInference({})
  const apiDefinition = inference.getApiDefinition()

  t.ok(
    Object.values(platformDefinitions).includes(apiDefinition),
    `API definition ${apiDefinition} is not in the platform definitions`
  )
})

test('BaseInference - getState returns initial flags', async t => {
  const inference = new BaseInference({})
  const state = inference.getState()
  t.alike(
    state,
    {
      configLoaded: false,
      weightsLoaded: false,
      destroyed: false
    },
    'Initial state flags should all be false'
  )
})

test('BaseInference - load calls _load and sets configLoaded', async t => {
  class T extends BaseInference {
    async _load () {
      this._loaded = true
    }
  }
  const inference = new T({})
  t.not(inference.getState().configLoaded, true, 'configLoaded starts false')
  await inference.load()
  t.ok(inference._loaded, '_load must have been called')
  t.ok(
    inference.getState().configLoaded,
    'configLoaded should be true after load()'
  )
})

test('BaseInference - load unloads existing model on second load', async t => {
  let unloadCalled = false
  let loadCount = 0

  class T extends BaseInference {
    async unload () {
      unloadCalled = true
    }

    async _load () {
      loadCount++
    }
  }

  const inference = new T({})

  // First load: just _load()
  await inference.load()
  t.is(loadCount, 1, '_load should be called once on first load')
  t.not(unloadCalled, true, 'unload should not be called on first load')

  // Second load: should trigger unload() then another _load()
  await inference.load()
  t.ok(unloadCalled, 'unload must be called before re-loading')
  t.is(loadCount, 2, '_load should be called again on reload')
})

test('BaseInference - _getFileContent throws when no loader', async t => {
  const inference = new BaseInference({})
  await t.exception(inference._getFileContent('foo.txt'))
})

test('BaseInference - loadWeights sets weightsLoaded even without _loadWeights', async t => {
  class T extends BaseInference {}
  const inference = new T({})
  t.not(inference.getState().weightsLoaded, true, 'weightsLoaded starts false')
  await inference.loadWeights({}) // no _loadWeights, should not throw
  t.ok(
    inference.getState().weightsLoaded,
    'weightsLoaded should be true after loadWeights()'
  )
})

test('BaseInference - unloadWeights clears weightsLoaded even without _unloadWeights', async t => {
  class T extends BaseInference {}
  const inference = new T({})
  inference.state.weightsLoaded = true
  await inference.unloadWeights() // no _unloadWeights, should not throw
  t.not(
    inference.getState().weightsLoaded,
    true,
    'weightsLoaded should be false after unloadWeights()'
  )
})

test('BaseInference - _createAddon throws when no interface provided', t => {
  const inference = new BaseInference({})

  try {
    inference._createAddon()
    t.fail('Should have thrown')
  } catch (err) {
    t.is(
      err.code,
      ERR_CODES.ADDON_INTERFACE_REQUIRED,
      'Should throw correct error code'
    )
    t.is(err.message, 'AddonInterface is required for this operation')
  }
})

test('BaseInference - _createAddon works correctly', t => {
  const append = () => Promise.resolve()
  const cancel = () => Promise.resolve()
  const pause = () => Promise.resolve()
  const activate = () => Promise.resolve()

  class MockAddon {
    constructor ({ config, outputCallback, logger }) {
      this.config = config
      this.outputCallback = outputCallback
      this.logger = logger
    }

    append = append
    cancel = cancel
    pause = pause
    activate = activate
  }

  const outputCallback = () => {}
  const inference = new BaseInference({})

  const addon = inference._createAddon(MockAddon, {
    config: { foo: 'bar' },
    outputCallback,
    logger: console.log
  })

  t.ok(addon, 'Addon should be created')
  t.is(
    addon.constructor.name,
    'MockAddon',
    'Addon should be instance of MockAddon'
  )
  t.is(addon.config.foo, 'bar', 'Addon should have config')
  t.is(addon.outputCallback, outputCallback, 'Addon should have outputCallback')
  t.is(addon.logger, console.log, 'Addon should have logger')
  t.is(addon.cancel, cancel, 'Addon should have cancel method')
  t.is(addon.pause, pause, 'Addon should have pause method')
  t.is(addon.activate, activate, 'Addon should have activate method')
})

test('BaseInference - _createResponse throws when addon not initialized', t => {
  const inference = new BaseInference({})
  try {
    inference._createResponse('job1')
    t.fail('Should have thrown')
  } catch (err) {
    t.is(
      err.code,
      ERR_CODES.ADDON_NOT_INITIALIZED,
      'Should throw correct error code'
    )
    t.is(
      err.message,
      'Addon has not been initialized',
      'Should throw correct error message'
    )
  }
})

test('BaseInference - _createResponse wires up handlers', t => {
  const inference = new BaseInference({})
  inference.addon = {
    cancel: async () => {},
    pause: async () => {},
    activate: async () => {}
  }

  const resp = inference._createResponse('job1')
  t.ok(typeof resp.cancel === 'function', 'cancel handler')
  t.ok(typeof resp.pause === 'function', 'pause handler')
  t.ok(typeof resp.continue === 'function', 'continue handler')
})

test('BaseInference - job response mapping management', t => {
  const inference = new BaseInference({})
  const job = 'job-x'
  const mock = {}
  inference._saveJobToResponseMapping(job, mock)
  t.ok(inference._jobToResponse.has(job), 'mapping saved')

  inference._deleteJobMapping(job)
  t.not(inference._jobToResponse.has(job), 'mapping deleted')
})

test('BaseInference - outputCallback handles all core events', t => {
  const inference = new BaseInference({ opts: { stats: true } })
  let failed = false
  let updated = false
  let ended = false
  let stats = false

  const mock = {
    failed: () => {
      failed = true
    },
    updateOutput: () => {
      updated = true
    },
    ended: () => {
      ended = true
    },
    updateStats: () => {
      stats = true
    }
  }

  // Error
  inference._saveJobToResponseMapping('e1', mock)
  inference._outputCallback(null, 'Error', 'e1', null, new Error('oops'))
  t.ok(failed, 'failed() called on Error')
  t.not(inference._jobToResponse.has('e1'), 'mapping removed on Error')

  // Output
  inference._saveJobToResponseMapping('o1', mock)
  inference._outputCallback(null, 'Output', 'o1', 'data')
  t.ok(updated, 'updateOutput() called on Output')
  t.ok(inference._jobToResponse.has('o1'), 'mapping retained on Output')

  // JobEnded
  inference._saveJobToResponseMapping('j1', mock)
  inference._outputCallback(null, 'JobEnded', 'j1', { foo: 'bar' })
  t.ok(stats, 'updateStats() called when stats=true')
  t.ok(ended, 'ended() called on JobEnded')
  t.not(inference._jobToResponse.has('j1'), 'mapping removed on JobEnded')
})

test('BaseInference - outputCallback missing response is no-op', t => {
  const inference = new BaseInference({})
  // should not throw
  inference._outputCallback(null, 'Output', 'nope', 'x')
  t.pass('gracefully ignored')
})

test('BaseInference - unload calls addon.unload when available', async t => {
  const inference = new BaseInference({})
  let called = false
  inference.addon = {
    unload: async () => {
      called = true
    }
  }
  await inference.unload()
  t.ok(called, 'addon.unload() must be invoked')
})

test('BaseInference - unload throws if addon lacks unload()', async t => {
  const inference = new BaseInference({})
  inference.addon = {}
  await t.exception(() => inference.unload(), {
    code: ERR_CODES.ADDON_METHOD_NOT_IMPLEMENTED
  })
})

test('BaseInference - destroy calls addon.destroyInstance()', async t => {
  const inference = new BaseInference({})
  let called = false
  inference.addon = {
    destroyInstance: async () => {
      called = true
    }
  }
  await inference.destroy()
  t.ok(called, 'addon.destroyInstance() must be invoked')
})

test('BaseInference - destroy throws if addon lacks destroyInstance()', async t => {
  const inference = new BaseInference({})
  inference.addon = {}
  await t.exception(() => inference.destroy(), {
    code: ERR_CODES.ADDON_METHOD_NOT_IMPLEMENTED
  })
})

test('BaseInference - constructor sets default options correctly', t => {
  const inference = new BaseInference({})
  t.ok(inference.opts, 'opts should be set')
  t.ok(inference.logger, 'logger should be set')
  t.not(inference.loader, 'loader should be null by default')
  t.ok(inference._jobToResponse instanceof Map, 'job mapping should be initialized')
  t.alike(inference.state, {
    configLoaded: false,
    weightsLoaded: false,
    destroyed: false
  }, 'state should be initialized')
})

test('BaseInference - constructor with custom options and loader', t => {
  const mockLoader = { getStream: () => {}, getFileSize: () => {} }
  const customOpts = { stats: true, customOption: 'test' }

  const mockLogger = {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {}
  }

  const inference = new BaseInference({
    opts: customOpts,
    loader: mockLoader,
    logger: mockLogger
  })

  t.is(inference.opts, customOpts, 'custom opts should be set')
  t.is(inference.loader, mockLoader, 'loader should be set')
})

test('BaseInference - downloadWeights calls _downloadWeights', async t => {
  let downloadCalled = false
  let passedSource = null
  let passedPath = null
  let passedCallback = null

  class T extends BaseInference {
    async _downloadWeights (source, diskPath, reportProgressCallback) {
      downloadCalled = true
      passedSource = source
      passedPath = diskPath
      passedCallback = reportProgressCallback
    }
  }

  const inference = new T({})
  const mockSource = { url: 'test' }
  const callback = () => {}

  await inference.downloadWeights(mockSource, '/tmp/test', callback)

  t.ok(downloadCalled, '_downloadWeights should be called')
  t.is(passedSource, mockSource, 'source should be passed')
  t.is(passedPath, '/tmp/test', 'disk path should be passed')
  t.is(passedCallback, callback, 'callback should be passed')
})

test('BaseInference - downloadWeights with default diskPath', async t => {
  let passedPath = null

  class T extends BaseInference {
    async _downloadWeights (source, diskPath) {
      passedPath = diskPath
    }
  }

  const inference = new T({})
  await inference.downloadWeights({ url: 'test' })

  t.is(passedPath, '', 'default diskPath should be empty string')
})

test('BaseInference - initProgressReport returns ProgressReport when loader has getFileSize', async t => {
  const mockLoader = {
    getFileSize: async (filepath) => {
      const sizes = { 'file1.bin': 100, 'file2.bin': 200 }
      return sizes[filepath] || 0
    }
  }

  const inference = new BaseInference({ loader: mockLoader })
  const callback = (data) => {}
  const weightFiles = ['file1.bin', 'file2.bin']

  const progressReport = await inference.initProgressReport(weightFiles, callback)

  t.ok(progressReport, 'should return ProgressReport instance')
  t.is(progressReport.totalSize, 300, 'total size should be calculated')
  t.is(progressReport.totalFiles, 2, 'total files should be set')
})

test('BaseInference - initProgressReport returns null when no callback', async t => {
  const mockLoader = { getFileSize: async () => 100 }
  const inference = new BaseInference({ loader: mockLoader })

  const progressReport = await inference.initProgressReport(['file1.bin'], null)

  t.not(progressReport, 'should return null when no callback')
})

test('BaseInference - initProgressReport returns null when loader lacks getFileSize', async t => {
  const mockLoader = { getStream: () => {} }
  const inference = new BaseInference({ loader: mockLoader })

  const progressReport = await inference.initProgressReport(['file1.bin'], () => {})

  t.not(progressReport, 'should return null when loader lacks getFileSize')
})

test('BaseInference - delete throws when no loader', async t => {
  const inference = new BaseInference({})

  await t.exception(() => inference.delete(), {
    code: ERR_CODES.LOAD_NOT_IMPLEMENTED
  })
})

test('BaseInference - delete throws when loader lacks deleteLocal', async t => {
  const mockLoader = { getStream: () => {} }
  const inference = new BaseInference({ loader: mockLoader })

  await t.exception(() => inference.delete(), {
    code: ERR_CODES.LOAD_NOT_IMPLEMENTED
  })
})

test('BaseInference - delete calls loader.deleteLocal', async t => {
  let deleteCalled = false
  const mockLoader = {
    deleteLocal: async () => { deleteCalled = true }
  }

  const inference = new BaseInference({ loader: mockLoader })
  await inference.delete()

  t.ok(deleteCalled, 'loader.deleteLocal should be called')
})

test('BaseInference - run throws when _runInternal not implemented', async t => {
  const inference = new BaseInference({})

  await t.exception(() => inference.run('test'), {
    code: ERR_CODES.NOT_IMPLEMENTED
  })
})

test('BaseInference - run calls _runInternal when implemented', async t => {
  let runCalled = false
  let passedInput = null

  class T extends BaseInference {
    async _runInternal (input) {
      runCalled = true
      passedInput = input
      return { result: 'test' }
    }
  }

  const inference = new T({})
  const result = await inference.run('test input')

  t.ok(runCalled, '_runInternal should be called')
  t.is(passedInput, 'test input', 'input should be passed')
  t.alike(result, { result: 'test' }, 'result should be returned')
})

test('BaseInference - pause throws when addon lacks pause', async t => {
  const inference = new BaseInference({})
  inference.addon = {}

  await t.exception(() => inference.pause(), {
    code: ERR_CODES.ADDON_METHOD_NOT_IMPLEMENTED
  })
})

test('BaseInference - pause calls addon.pause', async t => {
  let pauseCalled = false
  const inference = new BaseInference({})
  inference.addon = { pause: async () => { pauseCalled = true } }

  await inference.pause()
  t.ok(pauseCalled, 'addon.pause should be called')
})

test('BaseInference - unpause throws when addon lacks activate', async t => {
  const inference = new BaseInference({})
  inference.addon = {}

  await t.exception(() => inference.unpause(), {
    code: ERR_CODES.ADDON_METHOD_NOT_IMPLEMENTED
  })
})

test('BaseInference - unpause calls addon.activate', async t => {
  let activateCalled = false
  const inference = new BaseInference({})
  inference.addon = { activate: async () => { activateCalled = true } }

  await inference.unpause()
  t.ok(activateCalled, 'addon.activate should be called')
})

test('BaseInference - stop throws when addon lacks stop', async t => {
  const inference = new BaseInference({})
  inference.addon = {}

  await t.exception(() => inference.stop(), {
    code: ERR_CODES.ADDON_METHOD_NOT_IMPLEMENTED
  })
})

test('BaseInference - stop calls addon.stop', async t => {
  let stopCalled = false
  const inference = new BaseInference({})
  inference.addon = { stop: async () => { stopCalled = true } }

  await inference.stop()
  t.ok(stopCalled, 'addon.stop should be called')
})

test('BaseInference - status throws when addon lacks status', async t => {
  const inference = new BaseInference({})
  inference.addon = {}

  await t.exception(() => inference.status(), {
    code: ERR_CODES.ADDON_METHOD_NOT_IMPLEMENTED
  })
})

test('BaseInference - status calls addon.status and returns result', async t => {
  const statusResult = { active: true, model: 'test' }
  const inference = new BaseInference({})
  inference.addon = { status: async () => statusResult }

  const result = await inference.status()
  t.is(result, statusResult, 'should return addon status result')
})

test('BaseInference - _getConfigs throws when _getConfigPathNames not implemented', async t => {
  const inference = new BaseInference({})

  await t.exception(() => inference._getConfigs(), {
    code: ERR_CODES.NOT_IMPLEMENTED
  })
})

test('BaseInference - _getConfigs loads all config files', async t => {
  const configContents = {
    'config1.json': Buffer.from('{"test": 1}'),
    'config2.json': Buffer.from('{"test": 2}')
  }

  const mockLoader = {
    getStream: async (filepath) => (async function * () {
      yield configContents[filepath]
    })()
  }

  class T extends BaseInference {
    _getConfigPathNames () {
      return ['config1.json', 'config2.json']
    }
  }

  const inference = new T({ loader: mockLoader })
  const configs = await inference._getConfigs()

  t.ok(configs['config1.json'], 'config1.json should be loaded')
  t.ok(configs['config2.json'], 'config2.json should be loaded')
  t.alike(configs['config1.json'], Buffer.from('{"test": 1}'), 'config1 content should match')
  t.alike(configs['config2.json'], Buffer.from('{"test": 2}'), 'config2 content should match')
})

test('BaseInference - getApiDefinition returns platform-specific values', t => {
  const inference = new BaseInference({})
  const apiDef = inference.getApiDefinition()

  const validApis = ['vulkan', 'metal', 'vulkan-32']
  t.ok(validApis.includes(apiDef), `API definition ${apiDef} should be valid`)
})

test('BaseInference - state changes correctly during lifecycle', async t => {
  class T extends BaseInference {
    async _load () {}
    async _loadWeights () {}
    async _unloadWeights () {}
  }

  const inference = new T({})

  let state = inference.getState()
  t.not(state.configLoaded, 'initially config not loaded')
  t.not(state.weightsLoaded, 'initially weights not loaded')
  t.not(state.destroyed, 'initially not destroyed')

  await inference.load()
  state = inference.getState()
  t.ok(state.configLoaded, 'config loaded after load()')
  t.not(state.weightsLoaded, 'weights still not loaded')

  await inference.loadWeights({})
  state = inference.getState()
  t.ok(state.configLoaded, 'config still loaded')
  t.ok(state.weightsLoaded, 'weights now loaded')

  await inference.unloadWeights()
  state = inference.getState()
  t.ok(state.configLoaded, 'config still loaded')
  t.not(state.weightsLoaded, 'weights unloaded')
})

test('BaseInference - _getFileContent concatenates stream chunks correctly', async t => {
  const chunk1 = Buffer.from('Hello ')
  const chunk2 = Buffer.from('World')
  const expectedContent = Buffer.concat([chunk1, chunk2])

  const mockLoader = {
    getStream: async () => (async function * () {
      yield chunk1
      yield chunk2
    })()
  }

  const inference = new BaseInference({ loader: mockLoader })
  const content = await inference._getFileContent('test.txt')

  t.alike(content, expectedContent, 'chunks should be concatenated correctly')
})

test('BaseInference - _getFileContent handles empty streams', async t => {
  const mockLoader = {
    getStream: async () => (async function * () {
    })()
  }

  const inference = new BaseInference({ loader: mockLoader })
  const content = await inference._getFileContent('empty.txt')

  t.alike(content, Buffer.alloc(0), 'empty stream should return empty buffer')
})

test('BaseInference - initProgressReport handles path.basename correctly', async t => {
  const mockLoader = {
    getFileSize: async (filepath) => {
      return filepath.includes('nested') ? 200 : 100
    }
  }

  const inference = new BaseInference({ loader: mockLoader })
  const callback = () => {}
  const weightFiles = ['models/nested/weights.bin', 'config.json']

  const progressReport = await inference.initProgressReport(weightFiles, callback)

  t.ok(progressReport, 'should handle nested paths')
  t.is(progressReport.totalSize, 300, 'should calculate total size correctly')
  t.ok(progressReport.filesizeMapping['weights.bin'], 'should use basename for mapping key')
  t.ok(progressReport.filesizeMapping['config.json'], 'should use basename for mapping key')
})

test('BaseInference - outputCallback handles unknown event types gracefully', t => {
  const inference = new BaseInference({})

  const mockResponse = {
    failed: () => t.fail('should not call failed'),
    updateOutput: () => t.fail('should not call updateOutput'),
    ended: () => t.fail('should not call ended')
  }

  inference._saveJobToResponseMapping('test1', mockResponse)

  inference._outputCallback(null, 'UnknownEvent', 'test1', 'data')
  t.pass('unknown events should be handled gracefully')
})

test('BaseInference - outputCallback without stats option does not call updateStats', t => {
  const inference = new BaseInference({ opts: {} }) // No stats option
  let statsCalled = false

  const mockResponse = {
    ended: () => {},
    updateStats: () => { statsCalled = true }
  }

  inference._saveJobToResponseMapping('test1', mockResponse)
  inference._outputCallback(null, 'JobEnded', 'test1', { duration: 100 })

  t.not(statsCalled, 'updateStats should not be called when stats option is false')
})

test('WeightsProvider BaseInference - FinetuneProgress forwards stats when enabled', t => {
  const inference = new WeightsProviderBaseInference({ opts: { stats: true } })
  const progressStats = { loss: 1.23, current_batch: 2, total_batches: 10 }
  let updateStatsPayload = null

  const mockResponse = {
    updateStats: (stats) => { updateStatsPayload = stats }
  }

  inference._saveJobToResponseMapping('p1', mockResponse)
  inference._outputCallback(null, 'FinetuneProgress', 'p1', { stats: progressStats })

  t.is(updateStatsPayload, progressStats, 'progress stats should be forwarded as-is')
  t.ok(inference._jobToResponse.has('p1'), 'mapping should be retained for progress events')
})

test('WeightsProvider BaseInference - FinetuneProgress does not forward stats when disabled', t => {
  const inference = new WeightsProviderBaseInference({ opts: {} })
  let statsCalled = false

  const mockResponse = {
    updateStats: () => { statsCalled = true }
  }

  inference._saveJobToResponseMapping('p2', mockResponse)
  inference._outputCallback(null, 'FinetuneProgress', 'p2', { stats: { loss: 0.5 } })

  t.not(statsCalled, 'updateStats should not be called when stats option is false')
})

test('WeightsProvider BaseInference - JobEnded finetune terminal ends with payload and skips stats update', t => {
  const inference = new WeightsProviderBaseInference({ opts: { stats: true } })
  const terminalPayload = { op: 'finetune', status: 'PAUSED', stats: { train_loss: 0.4 } }
  let statsCalled = false
  let endedArg

  const mockResponse = {
    updateStats: () => { statsCalled = true },
    ended: (result) => { endedArg = result }
  }

  inference._saveJobToResponseMapping('f1', mockResponse)
  inference._outputCallback(null, 'JobEnded', 'f1', terminalPayload)

  t.not(statsCalled, 'terminal finetune payload should not be sent via updateStats')
  t.is(endedArg, terminalPayload, 'ended() should receive terminal finetune payload')
  t.not(inference._jobToResponse.has('f1'), 'mapping removed on JobEnded')
})

test('WeightsProvider BaseInference - JobEnded non-finetune still updates stats and ends normally', t => {
  const inference = new WeightsProviderBaseInference({ opts: { stats: true } })
  const normalPayload = { duration: 120 }
  let statsPayload
  let endedArg = 'not-called'

  const mockResponse = {
    updateStats: (stats) => { statsPayload = stats },
    ended: (result) => { endedArg = result }
  }

  inference._saveJobToResponseMapping('f2', mockResponse)
  inference._outputCallback(null, 'JobEnded', 'f2', normalPayload)

  t.is(statsPayload, normalPayload, 'non-finetune payload should still be forwarded to updateStats')
  t.is(endedArg, undefined, 'ended() should be called without terminal result for non-finetune jobs')
  t.not(inference._jobToResponse.has('f2'), 'mapping removed on JobEnded')
})

test('BaseInference - multiple loadWeights calls handle state correctly', async t => {
  let loadCount = 0

  class T extends BaseInference {
    async _loadWeights () {
      loadCount++
    }
  }

  const inference = new T({})

  await inference.loadWeights({})
  t.ok(inference.getState().weightsLoaded, 'weights loaded first time')
  t.is(loadCount, 1, '_loadWeights called once')

  await inference.loadWeights({})
  t.ok(inference.getState().weightsLoaded, 'weights still loaded second time')
  t.is(loadCount, 2, '_loadWeights called again')
})

test('BaseInference - unload resets both config and weights state', async t => {
  const inference = new BaseInference({})
  inference.addon = { unload: async () => {} }

  inference.state.configLoaded = true
  inference.state.weightsLoaded = true

  await inference.unload()

  const state = inference.getState()
  t.not(state.configLoaded, 'config should be unloaded')
  t.not(state.weightsLoaded, 'weights should be unloaded')
})

test('BaseInference - destroy sets destroyed flag and clears other states', async t => {
  const inference = new BaseInference({})
  inference.addon = { destroyInstance: async () => {} }

  inference.state.configLoaded = true
  inference.state.weightsLoaded = true

  await inference.destroy()

  const state = inference.getState()
  t.not(state.configLoaded, 'config should be cleared')
  t.not(state.weightsLoaded, 'weights should be cleared')
  t.ok(state.destroyed, 'destroyed flag should be set')
})

test('BaseInference - load with existing config calls unload first', async t => {
  let unloadCalled = false
  let loadCalled = false

  class T extends BaseInference {
    async unload () {
      unloadCalled = true
    }

    async _load () {
      loadCalled = true
    }
  }

  const inference = new T({})

  inference.state.configLoaded = true

  await inference.load()

  t.ok(unloadCalled, 'unload should be called when already loaded')
  t.ok(loadCalled, '_load should be called after unload')
})

test('BaseInference - load with existing weights calls unload first', async t => {
  let unloadCalled = false

  class T extends BaseInference {
    async unload () {
      unloadCalled = true
    }

    async _load () {}
  }

  const inference = new T({})

  inference.state.weightsLoaded = true

  await inference.load()

  t.ok(unloadCalled, 'unload should be called when weights are loaded')
})
