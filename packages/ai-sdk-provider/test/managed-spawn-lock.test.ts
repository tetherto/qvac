import assert from 'node:assert/strict'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import test from 'node:test'

import { releaseLock, tryLock } from '../src/managed/index.js'
import { lockPath, managedServesDir } from '../src/managed/registry.js'
import { withFakeHome } from './helpers/fake-serve.js'

const DEAD_PID = 2_147_483_646

test('tryLock acquires a free key', async () => {
  await withFakeHome(async () => {
    assert.equal(await tryLock('free'), true)
    // Held now → a second attempt by the same (live) owner can't reacquire.
    assert.equal(await tryLock('free'), false)
    await releaseLock('free')
    assert.equal(await tryLock('free'), true)
    await releaseLock('free')
  })
})

test('tryLock steals a lock whose owner process is dead', async () => {
  await withFakeHome(async () => {
    await mkdir(managedServesDir(), { recursive: true })
    await writeFile(lockPath('k'), String(DEAD_PID), 'utf8')
    // Dead owner → stealable immediately, regardless of age.
    assert.equal(await tryLock('k'), true)
    await releaseLock('k')
  })
})

test('tryLock does NOT steal a lock held by a live owner, even when stale by mtime', async () => {
  await withFakeHome(async () => {
    await mkdir(managedServesDir(), { recursive: true })
    // Owner is this (live) process; backdate the mtime far past any staleness
    // threshold to prove time alone never steals from a live cold start.
    await writeFile(lockPath('k'), String(process.pid), 'utf8')
    const old = new Date(Date.now() - 10 * 60 * 1000)
    await utimes(lockPath('k'), old, old)

    assert.equal(await tryLock('k'), false)
    await releaseLock('k')
  })
})

test('tryLock steals an empty/corrupt lock only once it is mtime-stale', async () => {
  await withFakeHome(async () => {
    await mkdir(managedServesDir(), { recursive: true })
    // Empty lock (crashed writer, no pid): fresh → not stolen; aged → stolen.
    await writeFile(lockPath('k'), '', 'utf8')
    assert.equal(await tryLock('k'), false)

    const old = new Date(Date.now() - 10 * 60 * 1000)
    await utimes(lockPath('k'), old, old)
    assert.equal(await tryLock('k'), true)
    await releaseLock('k')
  })
})
