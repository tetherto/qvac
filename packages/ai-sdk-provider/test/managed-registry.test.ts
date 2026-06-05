import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  addConsumer,
  consumersDir,
  findReusableServe,
  isProcessAlive,
  liveConsumers,
  managedServesDir,
  readRecord,
  removeConsumer,
  removeRecord,
  type ServeRecord,
  sweepServes,
  writeRecord
} from '../src/managed/registry.js'

const DEAD_PID = 2_147_483_646

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

function makeRecord (over: Partial<ServeRecord>): ServeRecord {
  return {
    fleetKey: 'k',
    servePid: process.pid,
    runnerPid: process.pid,
    port: 1,
    host: '127.0.0.1',
    baseURL: 'http://127.0.0.1:1/v1',
    configPath: '/tmp/x/qvac.config.json',
    startedAt: new Date().toISOString(),
    idleTimeoutMs: 1000,
    ...over
  }
}

// A throwaway health endpoint so findReusableServe's GET /v1/models succeeds.
async function listenHealthy (): Promise<{ baseURL: string, close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => { res.statusCode = 200; res.end('{"object":"list","data":[]}') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  return {
    baseURL: `http://127.0.0.1:${addr.port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('isProcessAlive is true for the current process and false for a dead pid', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(DEAD_PID), false)
  assert.equal(isProcessAlive(0), false)
  assert.equal(isProcessAlive(-1), false)
})

test('writeRecord / readRecord / removeRecord round-trip', async () => {
  await withFakeHome(async () => {
    await writeRecord(makeRecord({ fleetKey: 'abc', port: 1234 }))
    const rec = await readRecord('abc')
    assert.ok(rec)
    assert.equal(rec?.port, 1234)
    assert.deepEqual(await readdir(managedServesDir()), ['abc.json'])

    await removeRecord('abc')
    assert.equal(await readRecord('abc'), undefined)
  })
})

test('consumer markers: add, prune-dead, remove', async () => {
  await withFakeHome(async () => {
    await addConsumer('fk', process.pid)
    await addConsumer('fk', DEAD_PID)

    // liveConsumers keeps the live pid and prunes the dead marker file.
    const live = await liveConsumers('fk')
    assert.deepEqual(live, [process.pid])
    assert.deepEqual(await readdir(consumersDir('fk')), [String(process.pid)])

    await removeConsumer('fk', process.pid)
    assert.deepEqual(await liveConsumers('fk'), [])
  })
})

test('findReusableServe returns a healthy, owned serve and skips an unhealthy one', async () => {
  await withFakeHome(async () => {
    const healthy = await listenHealthy()
    try {
      await writeRecord(makeRecord({ fleetKey: 'live', baseURL: healthy.baseURL }))
      const found = await findReusableServe('live', fetch)
      assert.ok(found)
      assert.equal(found?.baseURL, healthy.baseURL)
    } finally {
      await healthy.close()
    }
    // After the server is gone the health check fails → not reusable.
    assert.equal(await findReusableServe('live', fetch), undefined)
  })
})

test('findReusableServe rejects a record whose serve pid is dead', async () => {
  await withFakeHome(async () => {
    await writeRecord(makeRecord({ fleetKey: 'dead', servePid: DEAD_PID }))
    assert.equal(await findReusableServe('dead', fetch), undefined)
  })
})

test('sweepServes drops dead-serve records and kills runner-orphaned serves', async () => {
  await withFakeHome(async () => {
    // 1) Dead serve → record dropped, nothing to kill.
    await writeRecord(makeRecord({ fleetKey: 'deadserve', servePid: DEAD_PID, runnerPid: DEAD_PID }))

    // 2) Live serve whose runner is dead → orphan: sweep must kill the serve.
    const orphan = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 100))
    assert.ok(orphan.pid)
    await writeRecord(makeRecord({ fleetKey: 'orphan', servePid: orphan.pid!, runnerPid: DEAD_PID, configPath: '' }))

    // 3) Healthy + owned (runner alive = this process) → left untouched.
    await writeRecord(makeRecord({ fleetKey: 'healthy', servePid: process.pid, runnerPid: process.pid }))

    const swept = await sweepServes()
    assert.ok(swept.includes('deadserve'))
    assert.ok(swept.includes('orphan'))
    assert.ok(!swept.includes('healthy'))

    await new Promise((r) => setTimeout(r, 200))
    assert.equal(isProcessAlive(orphan.pid!), false)
    assert.equal(await readRecord('orphan'), undefined)
    assert.equal(await readRecord('deadserve'), undefined)
    assert.ok(await readRecord('healthy'))

    await removeRecord('healthy')
  })
})

test('sweepServes returns empty when the dir does not exist', async () => {
  await withFakeHome(async () => {
    assert.deepEqual(await sweepServes(), [])
  })
})
