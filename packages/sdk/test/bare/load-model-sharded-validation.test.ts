import test from 'brittle'
import { z } from 'zod'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { clearPlugins, registerPlugin } from '@/server/plugins'
import { clearAllLoggingStreams } from '@/server/bare/registry/logging-stream-registry'
import { unregisterModel } from '@/server/bare/registry/model-registry'
import { loadModel } from '@/server/bare/ops/load-model'
import { ModelFileNotFoundError } from '@/utils/errors-server'

const MODEL_TYPE = 'sharded-validation-test'
const TOTAL_SHARDS = 3

function shardName(index: number) {
  const total = String(TOTAL_SHARDS).padStart(5, '0')
  return `model-${String(index).padStart(5, '0')}-of-${total}.gguf`
}

function createShardDir(shardsToWrite: number) {
  const shardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-sharded-load-'))

  for (let index = 1; index <= shardsToWrite; index++) {
    fs.writeFileSync(path.join(shardDir, shardName(index)), 'shard')
  }

  return shardDir
}

function loadOptions(modelPath: string) {
  return { type: 'loadModel' as const, modelSrc: modelPath, modelType: MODEL_TYPE, modelConfig: {} }
}

function registerStubPlugin() {
  const loadedPaths: string[] = []

  registerPlugin({
    modelType: MODEL_TYPE,
    displayName: 'Sharded validation test plugin',
    addonPackage: '@qvac/test-addon',
    loadConfigSchema: z.object({}),
    createModel: function (params) {
      loadedPaths.push(params.modelPath)
      return {
        model: {
          load: async function () {}
        }
      }
    },
    handlers: {}
  })

  return loadedPaths
}

test('sharded model loads when no .tensors.txt is present', async function (t) {
  clearPlugins()

  const shardDir = createShardDir(TOTAL_SHARDS)
  const modelId = 'sharded-load-without-tensors'
  const modelPath = path.join(shardDir, shardName(2))

  t.teardown(function () {
    unregisterModel(modelId)
    clearPlugins()
    clearAllLoggingStreams()
    fs.rmSync(shardDir, { recursive: true, force: true })
  })

  const loadedPaths = registerStubPlugin()

  await loadModel({
    modelId,
    modelPath,
    options: loadOptions(modelPath)
  })

  t.alike(loadedPaths, [modelPath], 'plugin received the requested shard path')
})

test('sharded model load reports the missing shards', async function (t) {
  clearPlugins()

  const shardDir = createShardDir(TOTAL_SHARDS - 1)
  const modelId = 'sharded-load-missing-shard'

  t.teardown(function () {
    unregisterModel(modelId)
    clearPlugins()
    clearAllLoggingStreams()
    fs.rmSync(shardDir, { recursive: true, force: true })
  })

  registerStubPlugin()

  const modelPath = path.join(shardDir, shardName(1))

  try {
    await loadModel({
      modelId,
      modelPath,
      options: loadOptions(modelPath)
    })
    t.fail('expected loadModel to throw')
  } catch (error) {
    t.ok(error instanceof ModelFileNotFoundError, 'throws ModelFileNotFoundError')
    // The e2e sharded-model expectation matches on this prefix
    t.ok(
      String((error as Error).message).includes('Missing shards for'),
      'message reports the missing shards'
    )
  }
})
