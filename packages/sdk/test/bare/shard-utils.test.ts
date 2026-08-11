import test from 'brittle'

test('getFirstShardPath: returns input for non-sharded model', async (t) => {
  const { getFirstShardPath } = await import('@/server/utils/shard-utils')
  t.is(getFirstShardPath('/models/llama-7b.gguf'), '/models/llama-7b.gguf')
})

test('getFirstShardPath: returns input for non-gguf file', async (t) => {
  const { getFirstShardPath } = await import('@/server/utils/shard-utils')
  t.is(getFirstShardPath('/models/something.bin'), '/models/something.bin')
})

test('getFirstShardPath: returns the same path when given the first shard', async (t) => {
  const { getFirstShardPath } = await import('@/server/utils/shard-utils')
  t.is(
    getFirstShardPath('/models/medgemma-4b-it-Q4_1-00001-of-00005.gguf'),
    '/models/medgemma-4b-it-Q4_1-00001-of-00005.gguf'
  )
})

test('getFirstShardPath: normalizes a middle shard to the first shard', async (t) => {
  const { getFirstShardPath } = await import('@/server/utils/shard-utils')
  t.is(
    getFirstShardPath('/models/medgemma-4b-it-Q4_1-00003-of-00005.gguf'),
    '/models/medgemma-4b-it-Q4_1-00001-of-00005.gguf'
  )
})

test('getFirstShardPath: normalizes the last shard to the first shard', async (t) => {
  const { getFirstShardPath } = await import('@/server/utils/shard-utils')
  t.is(
    getFirstShardPath('/models/medgemma-4b-it-Q4_1-00005-of-00005.gguf'),
    '/models/medgemma-4b-it-Q4_1-00001-of-00005.gguf'
  )
})

test('getFirstShardPath: preserves nested directories', async (t) => {
  const { getFirstShardPath } = await import('@/server/utils/shard-utils')
  t.is(
    getFirstShardPath('/some/nested/dir/Qwen3-1.7B-Q4_0-00002-of-00002.gguf'),
    '/some/nested/dir/Qwen3-1.7B-Q4_0-00001-of-00002.gguf'
  )
})

test('getFirstShardPath: handles single-shard sharded model (1-of-1)', async (t) => {
  const { getFirstShardPath } = await import('@/server/utils/shard-utils')
  t.is(getFirstShardPath('/models/tiny-00001-of-00001.gguf'), '/models/tiny-00001-of-00001.gguf')
})

test('getFirstShardPath: handles relative path without directory', async (t) => {
  const { getFirstShardPath } = await import('@/server/utils/shard-utils')
  t.is(getFirstShardPath('model-00002-of-00002.gguf'), 'model-00001-of-00002.gguf')
})

test('getFirstShardPath: handles Windows-style backslash separators', async (t) => {
  const { getFirstShardPath } = await import('@/server/utils/shard-utils')
  t.is(
    getFirstShardPath('C:\\models\\llama-00003-of-00003.gguf'),
    'C:\\models\\llama-00001-of-00003.gguf'
  )
})

test('getFirstShardPath: does not match a shard-like substring before the extension', async (t) => {
  const { getFirstShardPath } = await import('@/server/utils/shard-utils')
  t.is(
    getFirstShardPath('/models/foo-00001-of-00002-baseline.gguf'),
    '/models/foo-00001-of-00002-baseline.gguf'
  )
})

test('getFirstShardPath: returns input for zero-total shard count', async (t) => {
  const { getFirstShardPath } = await import('@/server/utils/shard-utils')
  t.is(getFirstShardPath('/models/empty-00000-of-00000.gguf'), '/models/empty-00000-of-00000.gguf')
})

test('getFirstShardPath: keeps the total shard count zero-padded to five digits', async (t) => {
  const { getFirstShardPath } = await import('@/server/utils/shard-utils')
  t.is(getFirstShardPath('/models/big-00007-of-00012.gguf'), '/models/big-00001-of-00012.gguf')
})

test('getFirstShardPath: normalizes shard groups with a non-gguf extension', async (t) => {
  const { getFirstShardPath } = await import('@/server/utils/shard-utils')
  t.is(
    getFirstShardPath('/models/weights-00004-of-00006.bin'),
    '/models/weights-00001-of-00006.bin'
  )
})
