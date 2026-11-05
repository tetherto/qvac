import test from 'brittle'
import { resolveClearStorageTarget, isCacheShardPath } from '@/utils/clear-storage'

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
