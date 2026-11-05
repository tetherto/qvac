import test from 'brittle'
import { resolveClearStorageTarget, resolveShardedClearStorageTargets } from '@/utils/clear-storage'

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

test('windows backslash paths are handled correctly', (t) => {
  const winCache = 'C:\\Users\\me\\.qvac\\models'
  const result = resolveClearStorageTarget(`${winCache}\\sets\\abc123\\model.onnx`, winCache)
  t.is(result.kind, 'directory')
  t.is(result.path, 'C:/Users/me/.qvac/models/sets/abc123')
})

const SHARD_FILES = ['qwen-00001-of-00002.gguf', 'qwen-00002-of-00002.gguf', 'qwen.tensors.txt']

test('sharded model in the cache deletes its shard directory', (t) => {
  const result = resolveShardedClearStorageTargets(
    `${CACHE}/sharded/abc123/qwen-00001-of-00002.gguf`,
    CACHE,
    SHARD_FILES
  )
  t.alike(result, [{ path: `${CACHE}/sharded/abc123`, kind: 'directory' }])
})

test('sharded model outside cache deletes only its own files', (t) => {
  const result = resolveShardedClearStorageTargets(
    '/Users/me/models/qwen-00001-of-00002.gguf',
    CACHE,
    SHARD_FILES
  )
  t.alike(result, [
    { path: '/Users/me/models/qwen-00001-of-00002.gguf', kind: 'file' },
    { path: '/Users/me/models/qwen-00002-of-00002.gguf', kind: 'file' },
    { path: '/Users/me/models/qwen.tensors.txt', kind: 'file' }
  ])
})

test('sharded model elsewhere in the cache deletes only its own files', (t) => {
  const result = resolveShardedClearStorageTargets(
    `${CACHE}/qwen-00001-of-00002.gguf`,
    CACHE,
    SHARD_FILES
  )
  t.is(result.length, 3)
  t.ok(result.every((target) => target.kind === 'file'))
})

test('sharded model at the cache shard root never deletes the sharded directory', (t) => {
  const result = resolveShardedClearStorageTargets(
    `${CACHE}/sharded/qwen-00001-of-00002.gguf`,
    CACHE,
    SHARD_FILES
  )
  t.ok(result.every((target) => target.kind === 'file'))
})

test('windows sharded model in the cache deletes its shard directory', (t) => {
  const winCache = 'C:\\Users\\me\\.qvac\\models'
  const result = resolveShardedClearStorageTargets(
    `${winCache}\\sharded\\abc123\\qwen-00001-of-00002.gguf`,
    winCache,
    SHARD_FILES
  )
  t.alike(result, [{ path: 'C:/Users/me/.qvac/models/sharded/abc123', kind: 'directory' }])
})
