import { describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNamedKvCacheRetention, folderUsage } from '@/serve/lib/responses-kv-cache'

const HOUR_MS = 60 * 60 * 1000

// Keys shaped like the ones the route generates: the prefix and a SHA-256 digest.
const key = (fill: string) => `responses-${fill.repeat(64)}`
const K = {
  old: key('0'),
  fresh: key('1'),
  a: key('a'),
  b: key('b'),
  c: key('c'),
  busy: key('2'),
  idle: key('3')
}
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
      [K.old]: { bytes: 10, ageMs: 25 * HOUR_MS },
      [K.fresh]: { bytes: 10, ageMs: HOUR_MS },
      'my-session': { bytes: 10, ageMs: 48 * HOUR_MS }
    })
    const deleted: string[] = []
    assert.equal(await retention(dir, deleted).sweep(), 1)
    assert.deepEqual(deleted, [K.old])
  })

  it('deletes the least recently used caches until under the quota', async (t) => {
    const dir = await cacheDir(t, {
      [K.a]: { bytes: 400, ageMs: 3 * HOUR_MS },
      [K.b]: { bytes: 400, ageMs: 2 * HOUR_MS },
      [K.c]: { bytes: 400, ageMs: HOUR_MS }
    })
    const deleted: string[] = []
    const r = retention(dir, deleted)
    for (const k of [K.a, K.b, K.c]) (await r.acquire(k))()
    await r.sweep()
    assert.deepEqual(deleted, [K.a])
  })

  it('never deletes a cache in use, and reclaims everything else on request', async (t) => {
    const dir = await cacheDir(t, {
      [K.busy]: { bytes: 10, ageMs: 30 * HOUR_MS },
      [K.idle]: { bytes: 10, ageMs: HOUR_MS }
    })
    const deleted: string[] = []
    const r = retention(dir, deleted)
    const release = await r.acquire(K.busy)
    ;(await r.acquire(K.idle))()
    assert.equal(await r.sweep({ all: true }), 1)
    assert.deepEqual(deleted, [K.idle])

    release()
    await r.sweep()
    assert.deepEqual(deleted, [K.idle, K.busy])
  })

  it('skips a key taken during the sweep and makes its request wait for a deletion', async (t) => {
    const dir = await cacheDir(t, {
      [K.a]: { bytes: 10, ageMs: 30 * HOUR_MS },
      [K.b]: { bytes: 10, ageMs: 29 * HOUR_MS }
    })
    const deleted: string[] = []
    let finishA!: () => void
    const r = createNamedKvCacheRetention({
      prefix: 'responses-',
      dir,
      idleTtlMs: 24 * HOUR_MS,
      now: () => NOW,
      deleteKey: (key) => {
        deleted.push(key)
        return key === K.a
          ? new Promise<void>((resolve) => {
              finishA = resolve
            })
          : Promise.resolve()
      }
    })

    const sweep = r.sweep()
    while (deleted.length === 0) await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(deleted, [K.a])

    // b is taken while a's deletion is pending: the sweep must leave it alone.
    const releaseB = await r.acquire(K.b)
    // A request for a waits until a's deletion finishes.
    let acquiredA = false
    const acquireA = r.acquire(K.a).then((release) => {
      acquiredA = true
      return release
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(acquiredA, false)

    finishA()
    assert.equal(await sweep, 1)
    assert.deepEqual(deleted, [K.a])
    ;(await acquireA)()
    releaseB()
  })

  it('looks under SNAP_USER_COMMON when set, like the SDK', async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'qvac-kv-snap-'))
    t.after(() => rm(home, { recursive: true, force: true }))
    await mkdir(join(home, '.qvac', 'kv-cache', K.old, 'model'), { recursive: true })
    const file = join(home, '.qvac', 'kv-cache', K.old, 'model', 'config.bin')
    await writeFile(file, Buffer.alloc(10))
    await utimes(file, new Date(NOW - 30 * HOUR_MS), new Date(NOW - 30 * HOUR_MS))
    const previous = process.env['SNAP_USER_COMMON']
    process.env['SNAP_USER_COMMON'] = home
    t.after(() => {
      if (previous === undefined) delete process.env['SNAP_USER_COMMON']
      else process.env['SNAP_USER_COMMON'] = previous
    })

    const deleted: string[] = []
    const r = createNamedKvCacheRetention({
      prefix: 'responses-',
      now: () => NOW,
      deleteKey: (key) => {
        deleted.push(key)
        return Promise.resolve()
      }
    })
    await r.sweep()
    assert.deepEqual(deleted, [K.old])
  })

  it('runs overlapping sweeps one after the other', async (t) => {
    const dir = await cacheDir(t, { [K.old]: { bytes: 10, ageMs: 30 * HOUR_MS } })
    const log: string[] = []
    const r = createNamedKvCacheRetention({
      prefix: 'responses-',
      dir,
      idleTtlMs: 24 * HOUR_MS,
      now: () => NOW,
      deleteKey: async (key) => {
        log.push(`start ${key}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
        log.push(`end ${key}`)
      }
    })
    await Promise.all([r.sweep(), r.sweep({ all: true })])
    assert.deepEqual(log, [`start ${K.old}`, `end ${K.old}`, `start ${K.old}`, `end ${K.old}`])
  })

  it('skips a cache folder that disappears during the scan', async () => {
    assert.equal(await folderUsage(join(tmpdir(), 'qvac-kv-retention-vanished')), null)
  })

  it('leaves caches that are not Responses keys alone', async (t) => {
    const dir = await cacheDir(t, { 'responses-my-session': { bytes: 10, ageMs: 48 * HOUR_MS } })
    const deleted: string[] = []
    const r = retention(dir, deleted)
    await r.sweep()
    await r.sweep({ all: true })
    assert.deepEqual(deleted, [])
  })

  it("only expires another server's caches, never evicts or reclaims them", async (t) => {
    const dir = await cacheDir(t, {
      [K.a]: { bytes: 800, ageMs: 2 * HOUR_MS },
      [K.b]: { bytes: 800, ageMs: HOUR_MS },
      [K.old]: { bytes: 10, ageMs: 30 * HOUR_MS }
    })
    const deleted: string[] = []
    const r = retention(dir, deleted)
    // Over the 1000-byte quota and reclaiming everything, yet a and b were never
    // used here, so only the expired cache goes.
    await r.sweep({ all: true })
    assert.deepEqual(deleted, [K.old])
  })

  it('rechecks a cache before deleting it', async (t) => {
    const dir = await cacheDir(t, {
      [K.a]: { bytes: 10, ageMs: 30 * HOUR_MS },
      [K.b]: { bytes: 10, ageMs: 29 * HOUR_MS }
    })
    const deleted: string[] = []
    let finishA!: () => void
    const r = createNamedKvCacheRetention({
      prefix: 'responses-',
      dir,
      idleTtlMs: 24 * HOUR_MS,
      now: () => NOW,
      deleteKey: (k) => {
        deleted.push(k)
        return k === K.a
          ? new Promise<void>((resolve) => {
              finishA = resolve
            })
          : Promise.resolve()
      }
    })
    const sweep = r.sweep()
    while (deleted.length === 0) await new Promise((resolve) => setImmediate(resolve))
    // b is used and released while a is being deleted: it is fresh now.
    ;(await r.acquire(K.b))()
    const file = join(dir, K.b, 'model', 'config.bin')
    await utimes(file, new Date(NOW), new Date(NOW))
    finishA()
    assert.equal(await sweep, 1)
    assert.deepEqual(deleted, [K.a])
  })

  it('forgets a key whose cache folder is gone once it is no longer in use', async (t) => {
    const dir = await cacheDir(t, {})
    const deleted: string[] = []
    const r = retention(dir, deleted)
    const release = await r.acquire(K.a)
    await r.sweep()
    assert.ok(r.ownedKeys().has(K.a), 'kept while in use')
    release()
    await r.sweep()
    assert.equal(r.ownedKeys().has(K.a), false)
  })

  it('treats a missing cache directory as empty', async () => {
    const deleted: string[] = []
    const r = retention(join(tmpdir(), 'qvac-kv-retention-missing'), deleted)
    assert.equal(await r.sweep(), 0)
  })
})
