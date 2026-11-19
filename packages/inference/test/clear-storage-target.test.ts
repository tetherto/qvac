import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { resolveClearStorageTarget, isCacheShardPath } from '@/utils/clear-storage'
import { registerModel, type AnyModel } from '@/runtime/model-registry'
import { unloadModel } from '@/plugins/ops/unload-model'
import { generateShardFilenames } from '@/utils/index'
import { ModelType } from '@/schemas'
import { useTestCacheDir } from './fixtures/test-cache'

const CACHE = '/home/user/.qvac/models'

test('companion set path deletes parent directory', (t) => {
  const result = resolveClearStorageTarget(`${CACHE}/sets/abc123/model.onnx`, CACHE)
  t.is(result.kind, 'directory')
  t.is(result.path, `${CACHE}/sets/abc123`)
})

test('legacy onnx path deletes parent directory', (t) => {
  const result = resolveClearStorageTarget(`${CACHE}/onnx/def456/encoder.onnx`, CACHE)
  t.is(result.kind, 'directory')
  t.is(result.path, `${CACHE}/onnx/def456`)
})

test('flat cache file deletes file only', (t) => {
  const result = resolveClearStorageTarget(`${CACHE}/abc123-model.gguf`, CACHE)
  t.is(result.kind, 'file')
  t.is(result.path, `${CACHE}/abc123-model.gguf`)
})

test('path outside cache always deletes file only', (t) => {
  const result = resolveClearStorageTarget('/Users/me/models/sets/foo/model.gguf', CACHE)
  t.is(result.kind, 'file')
  t.is(result.path, '/Users/me/models/sets/foo/model.gguf')
})

test('deeply nested cache path deletes file only', (t) => {
  const result = resolveClearStorageTarget(`${CACHE}/sets/abc123/subdir/model.onnx`, CACHE)
  t.is(result.kind, 'file')
  t.is(result.path, `${CACHE}/sets/abc123/subdir/model.onnx`)
})

test('cache dir with trailing slash is normalized', (t) => {
  const result = resolveClearStorageTarget(`${CACHE}/sets/abc123/model.onnx`, `${CACHE}/`)
  t.is(result.kind, 'directory')
  t.is(result.path, `${CACHE}/sets/abc123`)
})

test('dot segments never make a companion set or onnx directory target', (t) => {
  for (const modelPath of [
    `${CACHE}/sets/../model.gguf`,
    `${CACHE}/onnx/../model.onnx`,
    `${CACHE}/sets/./model.gguf`,
    `${CACHE}/onnx/./model.onnx`
  ]) {
    const result = resolveClearStorageTarget(modelPath, CACHE)
    t.is(result.kind, 'file', modelPath)
    t.is(result.path, modelPath, modelPath)
  }
})

test('windows backslash paths are handled correctly', (t) => {
  const winCache = 'C:\\Users\\me\\.qvac\\models'
  const result = resolveClearStorageTarget(`${winCache}\\sets\\abc123\\model.onnx`, winCache)
  t.is(result.kind, 'directory')
  t.is(result.path, 'C:/Users/me/.qvac/models/sets/abc123')
})

const SHARD = 'qwen-00001-of-00002.gguf'

test('sharded model in a cache shard directory matches', (t) => {
  t.ok(isCacheShardPath(`${CACHE}/sharded/abc123/${SHARD}`, CACHE))
})

test('sharded model outside cache does not match', (t) => {
  t.absent(isCacheShardPath(`/Users/me/models/${SHARD}`, CACHE))
  t.absent(isCacheShardPath(`/Users/me/models/sharded/abc123/${SHARD}`, CACHE))
})

test('sharded model elsewhere in the cache does not match', (t) => {
  t.absent(isCacheShardPath(`${CACHE}/${SHARD}`, CACHE))
  t.absent(isCacheShardPath(`${CACHE}/sharded/${SHARD}`, CACHE))
  t.absent(isCacheShardPath(`${CACHE}/sharded/abc123/sub/${SHARD}`, CACHE))
})

test('dot segments never match a cache shard directory', (t) => {
  t.absent(isCacheShardPath(`${CACHE}/sharded/../${SHARD}`, CACHE))
  t.absent(isCacheShardPath(`${CACHE}/sharded/./${SHARD}`, CACHE))
  t.absent(isCacheShardPath(`${CACHE}/sharded//${SHARD}`, CACHE))
})

test('backslash is a separator only on windows', (t) => {
  const winCache = 'C:\\Users\\me\\.qvac\\models'
  t.ok(isCacheShardPath(`${winCache}\\sharded\\abc123\\${SHARD}`, winCache, '\\'))
  t.absent(isCacheShardPath(`${CACHE}/sharded\\abc123/${SHARD}`, CACHE, '/'))
})

let counter = 0

// Registers a fake sharded model loaded from the first of `dir`'s two shards,
// with the shards and tensors.txt a sharded load expects next to it.
function registerShardedModel(dir: string): { modelId: string; modelFiles: string[] } {
  counter++
  const modelId = `clear-storage-${Date.now()}-${counter}`
  const modelFiles = [...generateShardFilenames(SHARD), 'qwen.tensors.txt']
  fs.mkdirSync(dir, { recursive: true })
  for (const name of modelFiles) fs.writeFileSync(path.join(dir, name), 'model')

  const model: AnyModel = {
    load: async () => {},
    unload: () => {},
    pause: () => {},
    run: async () => ({
      iterate: async function* () {},
      await: async () => undefined,
      cancel: async () => {}
    }),
    reload: async () => {}
  }
  registerModel(modelId, {
    model,
    path: path.join(dir, SHARD),
    config: {},
    modelType: ModelType.llamacppCompletion
  })
  return { modelId, modelFiles }
}

test('unloadModel clearStorage on a local sharded model keeps the rest of its folder', async (t) => {
  useTestCacheDir()
  const dir = path.join(os.tmpdir(), `qvac-clear-storage-local-${os.pid()}-${Date.now()}`)
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const { modelId, modelFiles } = registerShardedModel(dir)
  fs.writeFileSync(path.join(dir, 'thesis.txt'), 'not a model')
  fs.mkdirSync(path.join(dir, 'notes'))
  fs.writeFileSync(path.join(dir, 'notes', 'photo.txt'), 'not a model')

  await unloadModel({ modelId, clearStorage: true })

  for (const name of modelFiles) {
    t.absent(fs.existsSync(path.join(dir, name)), `${name} is removed`)
  }
  t.ok(fs.existsSync(path.join(dir, 'thesis.txt')), 'an unrelated file survives')
  t.ok(fs.existsSync(path.join(dir, 'notes', 'photo.txt')), 'an unrelated folder survives')
})

test('unloadModel clearStorage on a cached sharded model removes only its shard folder', async (t) => {
  const cacheDir = useTestCacheDir()
  const key = `clear-storage-${os.pid()}-${Date.now()}`
  const shardDir = path.join(cacheDir, 'sharded', key)
  const otherDir = path.join(cacheDir, 'sharded', `${key}-other`)
  t.teardown(() => {
    fs.rmSync(shardDir, { recursive: true, force: true })
    fs.rmSync(otherDir, { recursive: true, force: true })
  })
  const { modelId } = registerShardedModel(shardDir)
  fs.mkdirSync(otherDir, { recursive: true })
  fs.writeFileSync(path.join(otherDir, SHARD), 'another model')

  await unloadModel({ modelId, clearStorage: true })

  t.absent(fs.existsSync(shardDir), "the model's shard folder is removed")
  t.ok(fs.existsSync(path.join(otherDir, SHARD)), 'another cached sharded model survives')
})
