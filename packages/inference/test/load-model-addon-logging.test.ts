import test from 'brittle'
import { z } from 'zod'
import { loadModel } from '@/plugins/ops/load-model'
import { clearPlugins, registerPlugin } from '@/plugins/registry'
import { isModelLoaded, unregisterModel } from '@/runtime/model-registry'
import { ADDON_ASR } from '@/schemas'

// Addon logging forwards an addon's own log lines into the SDK logger. It is
// diagnostics: a model whose logger never attaches still loads and runs, only
// more quietly. And when the addon is genuinely unreachable, `createModel`
// fails on it anyway and reports the addon's own reason. So a load must not be
// failed by the logger wiring — the SDK would be turning an optional facility
// into a hard dependency, which is exactly what `peerDependenciesMeta:
// optional` says every addon is not.

function makePlugin(modelType: string, module: unknown, onCreate: () => void) {
  return {
    modelType,
    displayName: modelType,
    addonPackage: ADDON_ASR,
    // The model file is irrelevant here; this keeps the test off the disk.
    skipPrimaryModelPathValidation: true,
    loadConfigSchema: z.object({}),
    createModel() {
      onCreate()
      return {
        model: {
          load() {
            return Promise.resolve()
          }
        }
      }
    },
    handlers: {},
    logging: { module, namespace: `${modelType}-ns` }
  }
}

async function loadWith(modelType: string, modelId: string, module: unknown) {
  let created = false
  registerPlugin(
    makePlugin(modelType, module, () => {
      created = true
    })
  )
  await loadModel({
    modelId,
    modelPath: '/models/not-read.gguf',
    options: { type: 'loadModel', modelSrc: '/models/not-read.gguf', modelType, modelConfig: {} }
  })
  return created
}

test('a model still loads when its addon logger cannot be resolved', async (t) => {
  const modelId = 'addon-logging-unreachable'
  t.teardown(() => {
    unregisterModel(modelId)
    clearPlugins()
  })

  const created = await loadWith('addon-logging-unreachable-type', modelId, () => {
    throw new Error('@qvac/asr-ggml found no native prebuild for this host')
  })

  t.ok(created, 'the plugin was still asked to create the model')
  t.ok(isModelLoaded(modelId), 'and the model is loaded')
})

test('a model still loads when its addon logger resolves to an unusable shape', async (t) => {
  const modelId = 'addon-logging-bad-shape'
  t.teardown(() => {
    unregisterModel(modelId)
    clearPlugins()
  })

  // The shape seen in practice: the wrapper is the real module, but the values
  // it copied off the native binding are undefined.
  const created = await loadWith('addon-logging-bad-shape-type', modelId, () => ({
    setLogger: undefined,
    releaseLogger: undefined
  }))

  t.ok(created, 'the plugin was still asked to create the model')
  t.ok(isModelLoaded(modelId), 'and the model is loaded')
})

test('a load still fails when the model itself cannot be created', async (t) => {
  const modelId = 'addon-logging-model-fails'
  t.teardown(() => {
    unregisterModel(modelId)
    clearPlugins()
  })

  registerPlugin({
    modelType: 'addon-logging-model-fails-type',
    displayName: 'addon-logging-model-fails-type',
    addonPackage: ADDON_ASR,
    skipPrimaryModelPathValidation: true,
    loadConfigSchema: z.object({}),
    createModel() {
      throw new Error('the addon could not be loaded')
    },
    handlers: {},
    logging: {
      module: () => {
        throw new Error('no native prebuild')
      },
      namespace: 'addon-logging-model-fails-ns'
    }
  })

  await t.exception(
    () =>
      loadModel({
        modelId,
        modelPath: '/models/not-read.gguf',
        options: {
          type: 'loadModel',
          modelSrc: '/models/not-read.gguf',
          modelType: 'addon-logging-model-fails-type',
          modelConfig: {}
        }
      }),
    /could not be loaded/,
    "the addon's own failure is what surfaces, not the logging one"
  )
  t.absent(isModelLoaded(modelId))
})
