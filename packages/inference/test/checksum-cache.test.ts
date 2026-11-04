import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { calculateFileChecksum, measureChecksum } from '@/utils/checksum'

function fixture(t: ReturnType<typeof test>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-checksum-'))
  const file = path.join(dir, 'model.gguf')
  fs.writeFileSync(file, 'original model bytes')
  const createReadStream = fs.createReadStream
  let reads = 0
  fs.createReadStream = (...args: Parameters<typeof createReadStream>) => {
    reads++
    return createReadStream(...args)
  }
  t.teardown(() => {
    fs.createReadStream = createReadStream
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { file, reads: () => reads }
}

test('checksum cache: unchanged artifacts are read only once', async (t) => {
  const { file, reads } = fixture(t)
  const digest = await measureChecksum(file)
  for (let i = 0; i < 3; i++) t.is(await measureChecksum(file), digest)
  t.is(reads(), 1, 'warm checks do not stream the file again')
})

test('checksum cache: same-size corruption with restored mtime is rehashed', async (t) => {
  const { file, reads } = fixture(t)
  const original = await measureChecksum(file)
  const stats = fs.statSync(file)
  // Wait for a distinct filesystem change time, even on millisecond clocks.
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  fs.writeFileSync(file, 'corrupted model data')
  fs.utimesSync(file, stats.atime, stats.mtime)
  t.is(fs.statSync(file).size, stats.size)
  t.not(await measureChecksum(file), original, 'ctime invalidates the old digest')
  t.is(reads(), 2)
})

test('checksum cache: truncation, deletion, and replacement invalidate reuse', async (t) => {
  const { file, reads } = fixture(t)
  const original = await measureChecksum(file)
  fs.writeFileSync(file, 'partial')
  t.not(await measureChecksum(file), original)
  fs.unlinkSync(file)
  await t.exception(measureChecksum(file))
  fs.writeFileSync(file, 'original model bytes')
  t.is(await measureChecksum(file), original)
  const replacement = `${file}.replacement`
  fs.writeFileSync(replacement, 'replacement contents')
  fs.renameSync(replacement, file)
  t.not(await measureChecksum(file), original)
  t.is(reads(), 4, 'each new file state is hashed')
})

test('checksum cache: changes during hashing fail and are never retained', async (t) => {
  const { file } = fixture(t)
  const createReadStream = fs.createReadStream
  fs.createReadStream = (...args: Parameters<typeof createReadStream>) => {
    const stream = createReadStream(...args)
    stream.on('end', () => fs.appendFileSync(file, '!'))
    return stream
  }
  await t.exception(measureChecksum(file), /File changed during checksum calculation/)
  fs.createReadStream = createReadStream
  t.is(await measureChecksum(file), await calculateFileChecksum(file))
})

test('registry cache: warm reuse still rejects a changed expected checksum', async (t) => {
  const { validateCachedFile } = await import('@/handlers/load-model/registry-download-utils')
  const { file, reads } = fixture(t)
  const digest = await measureChecksum(file)
  const size = fs.statSync(file).size
  t.is(await validateCachedFile(file, 'model.gguf', size, digest), file)
  t.is(reads(), 1, 'download-time digest is reused on the first cache hit')
  t.is(await validateCachedFile(file, 'model.gguf', size, '0'.repeat(64)), null)
  t.absent(fs.existsSync(file), 'checksum mismatch removes the cached artifact')
})

test('shard cache: unchanged shards reuse verification and corruption is invalidated', async (t) => {
  const { checkShardCompleteness, getShardPath } = await import('@/utils/cache/paths')
  const { useTestCacheDir } = await import('./fixtures/test-cache')
  useTestCacheDir()
  const key = 'checksum-cache-test'
  const file = getShardPath(key, 'shard.gguf')
  t.teardown(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }))
  fs.writeFileSync(file, 'shard contents')
  const digest = await measureChecksum(file)
  const metadata = [{ filename: 'shard.gguf', expectedSize: 14, sha256Checksum: digest }]
  const createReadStream = fs.createReadStream
  let reads = 0
  fs.createReadStream = (...args: Parameters<typeof createReadStream>) => {
    reads++
    return createReadStream(...args)
  }
  t.teardown(() => {
    fs.createReadStream = createReadStream
  })
  t.alike(await checkShardCompleteness(key, ['shard.gguf'], metadata), [])
  t.is(reads, 0, 'completeness check reuses the download-time digest')
  t.alike(
    await checkShardCompleteness(
      key,
      ['shard.gguf'],
      [{ ...metadata[0]!, sha256Checksum: '0'.repeat(64) }]
    ),
    [0]
  )
  fs.writeFileSync(file, 'broken content')
  // Same size and inode, so only the timestamps mark the change; a rewrite in
  // the same millisecond would otherwise look unchanged.
  const later = new Date(fs.statSync(file).mtimeMs + 1000)
  fs.utimesSync(file, later, later)
  t.alike(await checkShardCompleteness(key, ['shard.gguf'], metadata), [0])
  t.is(reads, 1, 'changed shard is hashed again')
})
