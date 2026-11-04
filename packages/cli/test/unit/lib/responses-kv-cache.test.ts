import { describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNamedKvCacheRetention } from '@/serve/lib/responses-kv-cache'

const HOUR_MS = 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 4)

// Lays out `{key}/{modelId}/{configHash}.bin`, the SDK's named-cache layout.
async function cacheDir(
  t: TestContext,
  caches: Record<string, { bytes: number; ageMs: number }>
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qvac-kv-retention-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [key, { bytes, ageMs }] of Object.entries(caches)) {
    await mkdir(join(dir, key, 'model'), { recursive: true })
    const file = join(dir, key, 'model', 'config.bin')
    await writeFile(file, Buffer.alloc(bytes))
    const when = new Date(NOW - ageMs)
    await utimes(file, when, when)
  }
  return dir
}

function retention(dir: string, deleted: string[], maxBytes = 1000) {
  return createNamedKvCacheRetention({
    prefix: 'responses-',
    dir,
    maxBytes,
    idleTtlMs: 24 * HOUR_MS,
    now: () => NOW,
    deleteKey: (key) => {
      deleted.push(key)
      return Promise.resolve()
    }
  })
}

describe('createNamedKvCacheRetention', () => {
  it('deletes caches idle past the TTL and leaves other keys alone', async (t) => {
    const dir = await cacheDir(t, {
      'responses-old': { bytes: 10, ageMs: 25 * HOUR_MS },
      'responses-fresh': { bytes: 10, ageMs: HOUR_MS },
      'my-session': { bytes: 10, ageMs: 48 * HOUR_MS }
    })
    const deleted: string[] = []
    assert.equal(await retention(dir, deleted).sweep(), 1)
    assert.deepEqual(deleted, ['responses-old'])
  })

  it('deletes the least recently used caches until under the quota', async (t) => {
    const dir = await cacheDir(t, {
      'responses-a': { bytes: 400, ageMs: 3 * HOUR_MS },
      'responses-b': { bytes: 400, ageMs: 2 * HOUR_MS },
      'responses-c': { bytes: 400, ageMs: HOUR_MS }
    })
    const deleted: string[] = []
    await retention(dir, deleted).sweep()
    assert.deepEqual(deleted, ['responses-a'])
  })

  it('never deletes a cache in use, and reclaims everything else on request', async (t) => {
    const dir = await cacheDir(t, {
      'responses-busy': { bytes: 10, ageMs: 30 * HOUR_MS },
      'responses-idle': { bytes: 10, ageMs: HOUR_MS }
    })
    const deleted: string[] = []
    const r = retention(dir, deleted)
    const release = r.acquire('responses-busy')
    assert.equal(await r.sweep({ all: true }), 1)
    assert.deepEqual(deleted, ['responses-idle'])

    release()
    await r.sweep()
    assert.deepEqual(deleted, ['responses-idle', 'responses-busy'])
  })

  it('treats a missing cache directory as empty', async () => {
    const deleted: string[] = []
    const r = retention(join(tmpdir(), 'qvac-kv-retention-missing'), deleted)
    assert.equal(await r.sweep(), 0)
  })
})
