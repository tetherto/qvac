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
import { allocateFreePort, spawnServe } from '../src/managed/serve-process.js'
import { fakeServeSkip, makeFakeServe, setBehavior } from './helpers/fake-serve.js'

const DEAD_PID = 2_147_483_646

async function withFakeHome(fn: () => Promise<void>): Promise<void> {
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

function makeRecord(over: Partial<ServeRecord>): ServeRecord {
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
async function listenHealthy(): Promise<{ baseURL: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.statusCode = 200
    res.end('{"object":"list","data":[]}')
  })
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

    removeRecord('abc')
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

    removeConsumer('fk', process.pid)
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

test('per-instance consumer markers: one pid can hold several, removing one leaves the rest', async () => {
  await withFakeHome(async () => {
    // Two providers in one process sharing a fleet key each register a distinct
    // (pid-prefixed) marker. Closing one must not deregister the whole process.
    await addConsumer('fk', `${process.pid}.aaaa`)
    await addConsumer('fk', `${process.pid}.bbbb`)
    assert.deepEqual((await liveConsumers('fk')).sort(), [process.pid, process.pid])

    removeConsumer('fk', `${process.pid}.aaaa`)
    assert.deepEqual(await liveConsumers('fk'), [process.pid])
    assert.deepEqual(await readdir(consumersDir('fk')), [`${process.pid}.bbbb`])
  })
})

test('sweepServes drops dead-serve records and leaves healthy owned serves untouched', async () => {
  await withFakeHome(async () => {
    // Dead serve → record dropped, nothing to kill.
    await writeRecord(
      makeRecord({ fleetKey: 'deadserve', servePid: DEAD_PID, runnerPid: DEAD_PID })
    )
    // Healthy + owned (runner alive = this process) → left untouched.
    await writeRecord(
      makeRecord({ fleetKey: 'healthy', servePid: process.pid, runnerPid: process.pid })
    )

    const swept = await sweepServes()
    assert.ok(swept.includes('deadserve'))
    assert.ok(!swept.includes('healthy'))
    assert.equal(await readRecord('deadserve'), undefined)
    assert.ok(await readRecord('healthy'))

    removeRecord('healthy')
  })
})

test('removeRecord preserves the consumers dir only when asked', async () => {
  await withFakeHome(async () => {
    await writeRecord(makeRecord({ fleetKey: 'keepc' }))
    await addConsumer('keepc', process.pid)
    removeRecord('keepc', { preserveConsumers: true })
    assert.equal(await readRecord('keepc'), undefined)
    assert.deepEqual(await readdir(consumersDir('keepc')), [String(process.pid)])

    // Default still clears the markers.
    await writeRecord(makeRecord({ fleetKey: 'dropc' }))
    await addConsumer('dropc', process.pid)
    removeRecord('dropc')
    assert.deepEqual(await liveConsumers('dropc'), [])
  })
})

test('sweepServes keeps live consumer markers when reaping a dead serve', async () => {
  await withFakeHome(async () => {
    // A dead serve whose record is swept, but other live sessions still hold
    // consumer markers — they must survive so a respawned runner inherits them
    // instead of idle-reaping the fresh serve out from under those sessions.
    await writeRecord(makeRecord({ fleetKey: 'crashed', servePid: DEAD_PID, runnerPid: DEAD_PID }))
    await addConsumer('crashed', process.pid)
    await addConsumer('crashed', DEAD_PID)

    const swept = await sweepServes()
    assert.ok(swept.includes('crashed'))
    assert.equal(await readRecord('crashed'), undefined)
    // The live marker survives; the dead one is pruned on the next liveness read.
    assert.deepEqual(await liveConsumers('crashed'), [process.pid])
  })
})

test(
  'sweepServes kills a confirmed runner-orphaned serve but keeps a live-but-unhealthy record',
  { skip: fakeServeSkip },
  async () => {
    await withFakeHome(async () => {
      const fake = await makeFakeServe()
      setBehavior('healthy')
      const stranger = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], {
        stdio: 'ignore'
      })
      try {
        // Orphan that actually serves on its recorded baseURL → must be killed.
        const port = await allocateFreePort('127.0.0.1')
        const serve = await spawnServe({
          configPath: 'unused.json',
          port,
          serveBinPath: fake.binPath,
          startTimeoutMs: 10_000
        })
        await writeRecord(
          makeRecord({
            fleetKey: 'orphan',
            servePid: serve.pid,
            runnerPid: DEAD_PID,
            baseURL: serve.baseURL,
            configPath: ''
          })
        )

        // A live pid whose recorded baseURL answers nothing: could be our serve
        // mid-startup/hung, or a recycled pid. Sweep must NOT signal it AND must
        // NOT drop the record (dropping it would strand a live serve untracked).
        await new Promise((r) => setTimeout(r, 100))
        assert.ok(stranger.pid)
        await writeRecord(
          makeRecord({
            fleetKey: 'suspect',
            servePid: stranger.pid!,
            runnerPid: DEAD_PID,
            baseURL: 'http://127.0.0.1:1/v1',
            configPath: ''
          })
        )

        const swept = await sweepServes()
        assert.ok(swept.includes('orphan'))
        assert.ok(!swept.includes('suspect'), 'unhealthy-but-live serve must not be swept')

        await new Promise((r) => setTimeout(r, 300))
        assert.equal(isProcessAlive(serve.pid), false, 'serving orphan should be killed')
        assert.equal(
          isProcessAlive(stranger.pid!),
          true,
          'live-but-unhealthy pid must not be signalled'
        )
        assert.equal(await readRecord('orphan'), undefined)
        assert.ok(await readRecord('suspect'), 'record retained for a later sweep')
      } finally {
        if (stranger.pid !== undefined && isProcessAlive(stranger.pid)) stranger.kill('SIGKILL')
        removeRecord('suspect')
        setBehavior(undefined)
        await fake.cleanup()
      }
    })
  }
)

test('sweepServes returns empty when the dir does not exist', async () => {
  await withFakeHome(async () => {
    assert.deepEqual(await sweepServes(), [])
  })
})
