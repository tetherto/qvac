import test from 'brittle'
import env from 'bare-env'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { z } from 'zod'

import { handleLoadModel } from '@/handlers/load-model/handler'
import { registerPlugin, unregisterPlugin } from '@/plugins/registry'
import { deleteCache, getCacheFilePath, resolveCacheFilePath } from '@/plugins/ops/kv-cache-utils'
import { unregisterModel } from '@/runtime/model-registry'
import type { QvacPlugin } from '@/schemas/plugin'
import { kvCacheDirIdFor, kvCacheIdentityConfig } from '@/utils/index'

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

test('kvCacheIdentityConfig pins cache_share_across_keys to its default and keeps other keys', (t) => {
  t.alike(kvCacheIdentityConfig({ ctx_size: 4096, cache_share_across_keys: true }), {
    ctx_size: 4096,
    cache_share_across_keys: false
  })
  t.alike(kvCacheIdentityConfig({ ctx_size: 4096 }), { ctx_size: 4096 })
  t.is(kvCacheIdentityConfig(undefined), undefined)
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

  t.not(sharingId, isolatedId, 'sharing stays part of the loaded model identity')
  t.is(kvCacheDirIdFor(sharingId), isolatedId)
  t.is(
    resolveCacheFilePath(sharingId, CONFIG_HASH, 'chat-k'),
    savedPath,
    'the next turn with sharing on finds the file the chat already has'
  )
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

test('kv cache folder: a model id this process never loaded names its own folder', (t) => {
  t.is(kvCacheDirIdFor('never-loaded-model'), 'never-loaded-model')
  t.is(
    path.basename(path.dirname(resolveCacheFilePath('never-loaded-model', CONFIG_HASH, 'chat-x'))),
    'never-loaded-model'
  )
})
