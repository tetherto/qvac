import test from 'brittle'
import env from 'bare-env'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { z } from 'zod'

import { close, send } from '@/dispatch'
import { handleLoadModel } from '@/handlers/load-model/handler'
import { clearPlugins, registerPlugin, unregisterPlugin } from '@/plugins'
import { deleteCache, getCacheFilePath, resolveCacheFilePath } from '@/plugins/ops/kv-cache-utils'
import { unregisterModel } from '@/runtime/model-registry'
import { ModelType } from '@/schemas'
import type { LoadModelResponse, Request } from '@/schemas'
import type { QvacPlugin } from '@/schemas/plugin'
import { __kvCacheDirIdTestHooks, kvCacheDirIdFor, kvCacheIdentityConfig } from '@/utils/index'
import { getQvacPath } from '@/utils/qvac-paths'
import { makeFakePlugin } from './fixtures/fake-plugin'
import { useTestCacheDir } from './fixtures/test-cache'

env['HOME'] = path.join(os.tmpdir(), `qvac-kv-cache-dir-id-${os.pid()}`)

const PLUGIN_TYPE = 'kv-cache-dir-id-test'
const CONFIG_HASH = 'cfg0000000000000'

function registerFakePlugin(t: { teardown(fn: () => void): void }) {
  const plugin = {
    modelType: PLUGIN_TYPE,
    displayName: 'KV cache folder id',
    addonPackage: '@qvac/kv-cache-dir-id-test',
    loadConfigSchema: z.looseObject({}),
    createModel: () => ({ model: { load: async () => {}, unload: async () => {} } }),
    handlers: {}
  } as unknown as QvacPlugin
  registerPlugin(plugin)
  t.teardown(() => unregisterPlugin(plugin.modelType))
}

function writeModelFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-kv-cache-dir-id-model-'))
  const modelPath = path.join(dir, 'model.gguf')
  fs.writeFileSync(modelPath, '')
  return modelPath
}

async function load(modelSrc: string, modelConfig: Record<string, unknown>): Promise<string> {
  const response = await handleLoadModel({
    type: 'loadModel',
    modelSrc,
    modelType: PLUGIN_TYPE,
    modelConfig,
    modelFitPolicy: 'off'
  } as never)
  if (!response.success || !response.modelId) {
    throw new Error(`load failed: ${response.error ?? 'no modelId'}`)
  }
  return response.modelId
}

async function loadThroughDispatch(
  modelSrc: string,
  modelConfig: Record<string, unknown>
): Promise<string> {
  const response = (await send({
    type: 'loadModel',
    modelSrc,
    modelType: ModelType.llamacppCompletion,
    modelConfig,
    modelFitPolicy: 'off'
  } as unknown as Request)) as LoadModelResponse
  if (!response.success || !response.modelId) {
    throw new Error(`load failed: ${response.error ?? 'no modelId'}`)
  }
  return response.modelId
}

test('kvCacheIdentityConfig pins sent policy keys to their defaults and drops runtime-only keys', (t) => {
  t.alike(
    kvCacheIdentityConfig({
      ctx_size: 4096,
      cache_share_across_keys: true,
      openclCacheDir: '/data/app/opencl-cache/sdk-0.24.0',
      verbosity: 2,
      cache_ram_mib: 256
    }),
    { ctx_size: 4096, cache_share_across_keys: false, verbosity: 0 }
  )
  t.alike(
    kvCacheIdentityConfig({ ctx_size: 4096 }),
    { ctx_size: 4096 },
    'an absent key stays absent'
  )
  t.is(kvCacheIdentityConfig(undefined), undefined)
})

test('kv cache folder: a real load that omits cache_share_across_keys shares its folder with a sharing-on load', async (t) => {
  useTestCacheDir()
  clearPlugins()
  registerPlugin(makeFakePlugin(ModelType.llamacppCompletion))
  t.teardown(async () => {
    await close()
    clearPlugins()
  })
  const modelSrc = writeModelFile()

  const defaultId = await loadThroughDispatch(modelSrc, { ctx_size: 2048 })
  t.teardown(() => unregisterModel(defaultId))
  const sharingId = await loadThroughDispatch(modelSrc, {
    ctx_size: 2048,
    cache_share_across_keys: true
  })
  t.teardown(() => unregisterModel(sharingId))

  t.not(sharingId, defaultId, 'sharing stays part of the loaded model identity')
  t.is(kvCacheDirIdFor(defaultId), defaultId, 'a default load keeps its folder of today')
  t.is(kvCacheDirIdFor(sharingId), defaultId, 'turning sharing on reads the same folder')
})

test('kv cache folder: a real load keeps its folder of today with or without verbosity', async (t) => {
  useTestCacheDir()
  clearPlugins()
  registerPlugin(makeFakePlugin(ModelType.llamacppCompletion))
  t.teardown(async () => {
    await close()
    clearPlugins()
  })
  const modelSrc = writeModelFile()

  const quietId = await loadThroughDispatch(modelSrc, { ctx_size: 2560, verbosity: 0 })
  t.teardown(() => unregisterModel(quietId))
  const unsetId = await loadThroughDispatch(modelSrc, { ctx_size: 2560 })
  t.teardown(() => unregisterModel(unsetId))

  t.is(kvCacheDirIdFor(quietId), quietId, 'a load that sends verbosity 0 keeps its folder')
  t.is(kvCacheDirIdFor(unsetId), unsetId, 'a load without verbosity keeps its folder')
})

test('kv cache folder: turning on sharing and raising verbosity keeps the folder a verbosity 0 chat wrote', async (t) => {
  registerFakePlugin(t)
  const modelSrc = writeModelFile()

  const quietId = await load(modelSrc, {
    ctx_size: 2304,
    cache_share_across_keys: false,
    verbosity: 0
  })
  t.teardown(() => unregisterModel(quietId))
  const savedPath = await getCacheFilePath(quietId, CONFIG_HASH, 'chat-v')
  fs.writeFileSync(savedPath, 'kv')
  t.is(path.basename(path.dirname(savedPath)), quietId)

  const verboseId = await load(modelSrc, {
    ctx_size: 2304,
    cache_share_across_keys: true,
    verbosity: 2
  })
  t.teardown(() => unregisterModel(verboseId))

  t.not(verboseId, quietId)
  t.is(resolveCacheFilePath(verboseId, CONFIG_HASH, 'chat-v'), savedPath)
})

test('kv cache folder: turning on cache_share_across_keys keeps the folder an existing chat wrote', async (t) => {
  registerFakePlugin(t)
  const modelSrc = writeModelFile()

  const isolatedId = await load(modelSrc, { ctx_size: 2048, cache_share_across_keys: false })
  t.teardown(() => unregisterModel(isolatedId))
  const savedPath = await getCacheFilePath(isolatedId, CONFIG_HASH, 'chat-k')
  fs.writeFileSync(savedPath, 'kv')
  t.is(
    path.basename(path.dirname(savedPath)),
    isolatedId,
    'a load with sharing off keeps writing under its model id, as before'
  )

  const sharingId = await load(modelSrc, { ctx_size: 2048, cache_share_across_keys: true })
  t.teardown(() => unregisterModel(sharingId))

  t.is(
    resolveCacheFilePath(sharingId, CONFIG_HASH, 'chat-k'),
    savedPath,
    'the next turn with sharing on finds the file the chat already has'
  )
})

test('kv cache folder: runtime-only settings do not move the folder', async (t) => {
  registerFakePlugin(t)
  const modelSrc = writeModelFile()

  const beforeId = await load(modelSrc, {
    ctx_size: 3072,
    cache_share_across_keys: false,
    openclCacheDir: '/data/app/opencl-cache/sdk-0.24.0'
  })
  t.teardown(() => unregisterModel(beforeId))
  const afterId = await load(modelSrc, {
    ctx_size: 3072,
    cache_share_across_keys: true,
    openclCacheDir: '/data/app/opencl-cache/sdk-0.25.0',
    cache_ram_mib: 256
  })
  t.teardown(() => unregisterModel(afterId))

  t.not(afterId, beforeId)
  t.is(kvCacheDirIdFor(afterId), kvCacheDirIdFor(beforeId))
})

test('kv cache folder: other config changes still give a new folder', async (t) => {
  registerFakePlugin(t)
  const modelSrc = writeModelFile()

  const smallId = await load(modelSrc, { ctx_size: 1024, cache_share_across_keys: false })
  t.teardown(() => unregisterModel(smallId))
  const largeId = await load(modelSrc, { ctx_size: 8192, cache_share_across_keys: true })
  t.teardown(() => unregisterModel(largeId))

  t.not(
    path.dirname(resolveCacheFilePath(largeId, CONFIG_HASH, 'chat-k')),
    path.dirname(resolveCacheFilePath(smallId, CONFIG_HASH, 'chat-k'))
  )
})

test('kv cache folder: deleteCache by the sharing model id removes the shared folder', async (t) => {
  registerFakePlugin(t)
  const modelSrc = writeModelFile()

  const isolatedId = await load(modelSrc, { ctx_size: 512, cache_share_across_keys: false })
  t.teardown(() => unregisterModel(isolatedId))
  const sharingId = await load(modelSrc, { ctx_size: 512, cache_share_across_keys: true })
  t.teardown(() => unregisterModel(sharingId))

  const savedPath = await getCacheFilePath(isolatedId, CONFIG_HASH, 'chat-d')
  fs.writeFileSync(savedPath, 'kv')

  const removed = await deleteCache({ kvCacheKey: 'chat-d', modelId: sharingId })

  t.is(removed, path.dirname(savedPath))
  t.absent(fs.existsSync(savedPath))
})

test('kv cache folder: deleteCache by model id finds the shared folder in a process that never loaded the model', async (t) => {
  registerFakePlugin(t)
  const modelSrc = writeModelFile()

  const isolatedId = await load(modelSrc, { ctx_size: 640, cache_share_across_keys: false })
  const sharingId = await load(modelSrc, { ctx_size: 640, cache_share_across_keys: true })
  const sharedPath = await getCacheFilePath(isolatedId, CONFIG_HASH, 'chat-f')
  fs.writeFileSync(sharedPath, 'kv')
  const isolatedOnlyPath = await getCacheFilePath(isolatedId, CONFIG_HASH, 'chat-g')
  fs.writeFileSync(isolatedOnlyPath, 'kv')
  unregisterModel(isolatedId)
  unregisterModel(sharingId)
  __kvCacheDirIdTestHooks.forgetInMemory()

  await deleteCache({ kvCacheKey: 'chat-f', modelId: sharingId })
  t.absent(fs.existsSync(sharedPath), 'the sharing model id reaches the shared folder')

  await deleteCache({ kvCacheKey: 'chat-g', modelId: isolatedId })
  t.absent(fs.existsSync(isolatedOnlyPath), 'a sharing-off model id still names its own folder')
})

test('kv cache folder: a damaged saved mapping falls back to the model id', async (t) => {
  registerFakePlugin(t)
  const modelSrc = writeModelFile()

  const isolatedId = await load(modelSrc, { ctx_size: 768, cache_share_across_keys: false })
  const sharingId = await load(modelSrc, { ctx_size: 768, cache_share_across_keys: true })
  unregisterModel(isolatedId)
  unregisterModel(sharingId)
  const mappingPath = getQvacPath('kv-cache-dir-ids', sharingId)
  t.is(fs.readFileSync(mappingPath).toString(), isolatedId, 'the load saved the full mapping')
  t.absent(
    fs.readdirSync(path.dirname(mappingPath)).some((name) => name.includes('.tmp-')),
    'no temporary file is left behind'
  )

  fs.writeFileSync(mappingPath, isolatedId.slice(0, 7))
  __kvCacheDirIdTestHooks.forgetInMemory()

  const removed = await deleteCache({ kvCacheKey: 'chat-p', modelId: sharingId })
  t.is(path.basename(removed), sharingId, 'a partial id is not used as a folder name')
})

test('kv cache folder: a model id this process never loaded names its own folder', (t) => {
  t.is(kvCacheDirIdFor('never-loaded-model'), 'never-loaded-model')
  t.is(
    path.basename(path.dirname(resolveCacheFilePath('never-loaded-model', CONFIG_HASH, 'chat-x'))),
    'never-loaded-model'
  )
})
