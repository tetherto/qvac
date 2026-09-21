import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  addConsumer,
  consumersDir,
  ensureDirSync,
  ensureManagedServesDir,
  findReusableServe,
  isProcessAlive,
  liveConsumers,
  managedServesDir,
  readRecord,
  removeConsumer,
  removeRecord,
  RUNNER_PARAMS_STALE_MS,
  type ServeRecord,
  sweepServes,
  writeRecord
} from '../src/managed/registry.js'
import { releaseLock, tryLock } from '../src/managed/index.js'
import { allocateFreePort, spawnServe } from '../src/managed/serve-process.js'
import { fakeServeSkip, makeFakeServe, setBehavior } from './helpers/fake-serve.js'

const DEAD_PID = 2_147_483_646
const API_KEY = 'managed-registry-test-key'

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
    apiKey: API_KEY,
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
async function listenHealthy(): Promise<{
  baseURL: string
  port: number
  close: () => Promise<void>
}> {
  const server: Server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    res.statusCode = 200
    res.end('{"object":"list","data":[]}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  return {
    baseURL: `http://127.0.0.1:${addr.port}/v1`,
    port: addr.port,
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
    await writeRecord(
      makeRecord({ fleetKey: 'abc', port: 1234, baseURL: 'http://127.0.0.1:1234/v1' })
    )
    const rec = await readRecord('abc')
    assert.ok(rec)
    assert.equal(rec?.port, 1234)
    assert.deepEqual(await readdir(managedServesDir()), ['abc.json'])
    const mode = (await stat(join(managedServesDir(), 'abc.json'))).mode & 0o777
    assert.equal(mode, 0o600)

    removeRecord('abc')
    assert.equal(await readRecord('abc'), undefined)
  })
})

test('managed registry paths self-heal permissions in production creation order', async () => {
  await withFakeHome(async () => {
    const fleetKey = 'secure'
    const consumerId = `${process.pid}.secure`

    await addConsumer(fleetKey, consumerId)
    assert.equal((await stat(managedServesDir())).mode & 0o777, 0o700)
    assert.equal((await stat(consumersDir(fleetKey))).mode & 0o777, 0o700)
    assert.equal((await stat(join(consumersDir(fleetKey), consumerId))).mode & 0o777, 0o600)

    await chmod(managedServesDir(), 0o777)
    assert.equal(await tryLock(fleetKey), true)
    assert.equal((await stat(managedServesDir())).mode & 0o777, 0o700)
    await releaseLock(fleetKey)

    await chmod(managedServesDir(), 0o777)
    await writeRecord(makeRecord({ fleetKey }))
    assert.equal((await stat(managedServesDir())).mode & 0o777, 0o700)
    assert.equal((await stat(join(managedServesDir(), `${fleetKey}.json`))).mode & 0o777, 0o600)

    await chmod(managedServesDir(), 0o777)
    ensureDirSync()
    assert.equal((await stat(managedServesDir())).mode & 0o777, 0o700)
  })
})

test('readRecord rejects legacy records without an apiKey as stale', async () => {
  await withFakeHome(async () => {
    const { apiKey: _apiKey, ...legacy } = makeRecord({ fleetKey: 'legacy' })
    await writeRecord(legacy as ServeRecord)

    assert.equal(await readRecord('legacy'), undefined)
  })
})

test('sweepServes removes a dead legacy keyless record and its config artifacts', async () => {
  await withFakeHome(async () => {
    const configDir = join(managedServesDir(), 'legacy-config')
    const configPath = join(configDir, 'qvac.config.json')
    await mkdir(configDir, { recursive: true })
    await writeFile(configPath, '{}')
    const { apiKey: _apiKey, ...legacy } = makeRecord({
      fleetKey: 'legacy-dead',
      servePid: DEAD_PID,
      runnerPid: DEAD_PID,
      configPath
    })
    await writeRecord(legacy as ServeRecord)

    assert.deepEqual(await sweepServes(), ['legacy-dead'])
    await assert.rejects(stat(join(managedServesDir(), 'legacy-dead.json')), { code: 'ENOENT' })
    await assert.rejects(stat(configDir), { code: 'ENOENT' })
  })
})

test('sweepServes reaps a live legacy keyless serve, probing it without authorization', async () => {
  await withFakeHome(async () => {
    const configDir = join(managedServesDir(), 'legacy-live-config')
    const configPath = join(configDir, 'qvac.config.json')
    await mkdir(configDir, { recursive: true })
    await writeFile(configPath, '{}')

    // A serve started by a pre-auth provider: alive, listening without a key,
    // and its runner is gone, so nothing else will ever shut it down.
    const legacyServe = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], {
      stdio: 'ignore'
    })
    // An unrelated process whose recorded destination answers nothing.
    const stranger = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 100))
    assert.ok(legacyServe.pid)
    assert.ok(stranger.pid)

    try {
      const { apiKey: _live, ...liveLegacy } = makeRecord({
        fleetKey: 'legacy-live',
        servePid: legacyServe.pid,
        runnerPid: DEAD_PID,
        host: '127.0.0.1',
        port: 4242,
        baseURL: 'http://127.0.0.1:4242/v1',
        configPath
      })
      await writeRecord(liveLegacy as ServeRecord)

      const { apiKey: _quiet, ...quietLegacy } = makeRecord({
        fleetKey: 'legacy-quiet',
        servePid: stranger.pid,
        runnerPid: DEAD_PID,
        host: '127.0.0.1',
        port: 4243,
        baseURL: 'http://127.0.0.1:4243/v1',
        configPath: ''
      })
      await writeRecord(quietLegacy as ServeRecord)

      const probed: string[] = []
      const fetchImpl: typeof fetch = (input, init) => {
        const url = String(input)
        probed.push(url)
        // A keyless legacy serve must be probed anonymously — sending the
        // Authorization header of a *different* record would be a credential leak.
        assert.equal(new Headers(init?.headers).get('authorization'), null)
        if (url.startsWith('http://127.0.0.1:4242/')) {
          return Promise.resolve(new Response(null, { status: 200 }))
        }
        return Promise.reject(new Error('ECONNREFUSED'))
      }

      const swept = await sweepServes(fetchImpl)
      assert.ok(swept.includes('legacy-live'), 'a confirmed legacy serve must be reaped')
      assert.ok(!swept.includes('legacy-quiet'), 'an unconfirmed live pid must not be swept')
      assert.deepEqual(probed.sort(), [
        'http://127.0.0.1:4242/v1/models',
        'http://127.0.0.1:4243/v1/models'
      ])

      await new Promise((r) => setTimeout(r, 300))
      assert.equal(isProcessAlive(legacyServe.pid), false, 'legacy serve should be terminated')
      assert.equal(isProcessAlive(stranger.pid), true, 'unrelated pid must not be signalled')
      assert.equal(await readRecord('legacy-live'), undefined)
      await assert.rejects(stat(join(managedServesDir(), 'legacy-live.json')), { code: 'ENOENT' })
      await assert.rejects(stat(configDir), { code: 'ENOENT' })
      assert.ok(await readSweptRecordExists('legacy-quiet'), 'record retained for a later sweep')
    } finally {
      for (const child of [legacyServe, stranger]) {
        if (child.pid !== undefined && isProcessAlive(child.pid)) child.kill('SIGKILL')
      }
      removeRecord('legacy-quiet')
    }
  })
})

test('sweepServes rejects a legacy record with a mismatched destination before probing', async () => {
  await withFakeHome(async () => {
    const { apiKey: _apiKey, ...tampered } = makeRecord({
      fleetKey: 'legacy-tampered',
      servePid: process.pid,
      runnerPid: DEAD_PID,
      host: '127.0.0.1',
      port: 4242,
      baseURL: 'http://evil.example:4242/v1',
      configPath: ''
    })
    await writeRecord(tampered as ServeRecord)

    let calls = 0
    const fetchImpl: typeof fetch = () => {
      calls += 1
      return Promise.resolve(new Response(null, { status: 200 }))
    }

    assert.deepEqual(await sweepServes(fetchImpl), [])
    assert.equal(calls, 0, 'a record whose baseURL disagrees with host/port is never probed')
    removeRecord('legacy-tampered')
  })
})

test('sweepServes unlinks abandoned runner-params files but keeps fresh handoffs', async () => {
  await withFakeHome(async () => {
    await ensureManagedServesDir()
    const stale = join(managedServesDir(), 'gone.1234.abcdef.runner-params.json')
    const fresh = join(managedServesDir(), 'live.5678.fedcba.runner-params.json')
    await writeFile(stale, '{}', { mode: 0o600 })
    await writeFile(fresh, '{}', { mode: 0o600 })
    // Older than the spawn budget: whoever wrote it can no longer be waiting.
    const old = Date.now() - RUNNER_PARAMS_STALE_MS - 60_000
    await utimes(stale, new Date(old), new Date(old))

    await sweepServes()

    await assert.rejects(stat(stale), { code: 'ENOENT' })
    assert.ok(await stat(fresh), 'an in-flight handoff file must survive the sweep')
  })
})

async function readSweptRecordExists(fleetKey: string): Promise<boolean> {
  try {
    await stat(join(managedServesDir(), `${fleetKey}.json`))
    return true
  } catch {
    return false
  }
}

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
      await writeRecord(
        makeRecord({ fleetKey: 'live', baseURL: healthy.baseURL, port: healthy.port })
      )
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

test('findReusableServe rejects mismatched record destinations before sending authorization', async () => {
  await withFakeHome(async () => {
    await writeRecord(
      makeRecord({
        fleetKey: 'mismatch',
        host: '127.0.0.1',
        port: 1234,
        baseURL: 'http://localhost:5678/v1'
      })
    )
    let fetchCalls = 0
    const fetchImpl: typeof fetch = () => {
      fetchCalls += 1
      return Promise.resolve(new Response(null, { status: 200 }))
    }

    assert.equal(await findReusableServe('mismatch', fetchImpl), undefined)
    assert.equal(fetchCalls, 0)
  })
})

test('findReusableServe accepts an authenticated non-loopback destination', async () => {
  await withFakeHome(async () => {
    await writeRecord(
      makeRecord({
        fleetKey: 'network',
        host: '192.0.2.10',
        port: 4321,
        baseURL: 'http://192.0.2.10:4321/v1'
      })
    )
    const fetchImpl: typeof fetch = (_input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${API_KEY}`)
      return Promise.resolve(new Response(null, { status: 200 }))
    }

    assert.ok(await findReusableServe('network', fetchImpl))
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
          apiKey: API_KEY,
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
            port: serve.port,
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
