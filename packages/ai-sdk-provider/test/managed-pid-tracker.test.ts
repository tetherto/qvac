import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  forgetServe,
  isProcessAlive,
  managedServesDir,
  recordServe,
  sweepStaleServes
} from '../src/managed/pid-tracker.js'

// Redirect ~/.qvac to a throwaway dir so tests never touch a real user's
// managed-serves state. `os.homedir()` honours $HOME (and USERPROFILE on
// Windows) via libuv, which `managedServesDir()` reads on every call.
async function withFakeHome (fn: () => Promise<void>): Promise<void> {
  const prevHome = process.env['HOME']
  const prevUserProfile = process.env['USERPROFILE']
  const fakeHome = await mkdtemp(join(tmpdir(), 'qvac-home-'))
  process.env['HOME'] = fakeHome
  process.env['USERPROFILE'] = fakeHome
  try {
    await fn()
  } finally {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevUserProfile === undefined) delete process.env['USERPROFILE']
    else process.env['USERPROFILE'] = prevUserProfile
    await rm(fakeHome, { recursive: true, force: true })
  }
}

test('isProcessAlive is true for the current process and false for a dead pid', () => {
  assert.equal(isProcessAlive(process.pid), true)
  // A pid that is essentially never live. process.kill rejects it with ESRCH.
  assert.equal(isProcessAlive(2_147_483_646), false)
  assert.equal(isProcessAlive(0), false)
  assert.equal(isProcessAlive(-1), false)
})

test('recordServe writes a record and forgetServe removes it', async () => {
  await withFakeHome(async () => {
    await recordServe({ pid: process.pid, port: 12345, configPath: '/tmp/x.json', startedAt: new Date().toISOString() })

    let files = await readdir(managedServesDir())
    assert.deepEqual(files, [`${process.pid}.json`])

    await forgetServe(process.pid)
    files = await readdir(managedServesDir())
    assert.deepEqual(files, [])

    // forgetServe is a no-op when the record is already gone.
    await forgetServe(process.pid)
  })
})

test('sweepStaleServes removes dead-pid records but keeps live ones', async () => {
  await withFakeHome(async () => {
    const deadPid = 2_147_483_646
    await recordServe({ pid: deadPid, port: 1, configPath: '/tmp/dead.json', startedAt: new Date().toISOString() })
    await recordServe({ pid: process.pid, port: 2, configPath: '/tmp/live.json', startedAt: new Date().toISOString() })

    const swept = await sweepStaleServes()
    assert.deepEqual(swept, [deadPid])

    const files = await readdir(managedServesDir())
    assert.deepEqual(files, [`${process.pid}.json`])

    await forgetServe(process.pid)
  })
})

test('sweepStaleServes returns empty when the dir does not exist', async () => {
  await withFakeHome(async () => {
    const swept = await sweepStaleServes()
    assert.deepEqual(swept, [])
  })
})
