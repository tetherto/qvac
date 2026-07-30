import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ServeExitedError, ServeStartTimeoutError } from '../src/managed/errors.js'
import { isProcessAlive } from '../src/managed/registry.js'
import { allocateFreePort, spawnServe, stopServe } from '../src/managed/serve-process.js'
import { fakeServeSkip as skip, makeFakeServe, setBehavior } from './helpers/fake-serve.js'

test(
  'spawnServe brings up a healthy serve, reports coordinates, then stopServe terminates it',
  { skip },
  async () => {
    const fake = await makeFakeServe()
    setBehavior('healthy')
    try {
      const port = await allocateFreePort('127.0.0.1')
      const serve = await spawnServe({
        configPath: 'unused.json',
        port,
        serveBinPath: fake.binPath,
        startTimeoutMs: 10_000
      })

      assert.equal(serve.port, port)
      assert.ok(serve.pid > 0)
      assert.equal(serve.baseURL, `http://127.0.0.1:${port}/v1`)
      assert.equal(isProcessAlive(serve.pid), true)

      const res = await fetch(`${serve.baseURL}/models`)
      assert.equal(res.status, 200)

      await stopServe(serve.child)
      await new Promise((r) => setTimeout(r, 200))
      assert.equal(isProcessAlive(serve.pid), false)

      // stopServe is idempotent.
      await stopServe(serve.child)
    } finally {
      setBehavior(undefined)
      await fake.cleanup()
    }
  }
)

test(
  'spawnServe throws ServeStartTimeoutError when the serve never gets healthy',
  { skip },
  async () => {
    const fake = await makeFakeServe()
    setBehavior('never-listen')
    try {
      await assert.rejects(
        spawnServe({
          configPath: 'unused.json',
          port: await allocateFreePort('127.0.0.1'),
          serveBinPath: fake.binPath,
          startTimeoutMs: 600
        }),
        (err: unknown) => {
          assert.ok(err instanceof ServeStartTimeoutError)
          assert.equal(err.code, 'SERVE_START_TIMEOUT')
          return true
        }
      )
    } finally {
      setBehavior(undefined)
      await fake.cleanup()
    }
  }
)

test(
  'spawnServe throws ServeExitedError when the serve exits before health',
  { skip },
  async () => {
    const fake = await makeFakeServe()
    setBehavior('exit-immediately')
    try {
      await assert.rejects(
        spawnServe({
          configPath: 'unused.json',
          port: await allocateFreePort('127.0.0.1'),
          serveBinPath: fake.binPath,
          startTimeoutMs: 5_000
        }),
        (err: unknown) => {
          assert.ok(err instanceof ServeExitedError)
          assert.equal(err.code, 'SERVE_EXITED')
          assert.equal(err.exitCode, 3)
          return true
        }
      )
    } finally {
      setBehavior(undefined)
      await fake.cleanup()
    }
  }
)

test('stopServe escalates to SIGKILL when SIGTERM is ignored', { skip }, async () => {
  const fake = await makeFakeServe()
  setBehavior('ignore-sigterm')
  try {
    const serve = await spawnServe({
      configPath: 'unused.json',
      port: await allocateFreePort('127.0.0.1'),
      serveBinPath: fake.binPath,
      startTimeoutMs: 10_000
    })
    assert.equal(isProcessAlive(serve.pid), true)

    await stopServe(serve.child, 300)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(isProcessAlive(serve.pid), false)
  } finally {
    setBehavior(undefined)
    await fake.cleanup()
  }
})

test(
  "stopServe reaps the serve's whole process group, not just the serve pid",
  { skip },
  async () => {
    const fake = await makeFakeServe()
    setBehavior('spawn-stubborn-worker')
    const dir = await mkdtemp(join(tmpdir(), 'qvac-worker-'))
    const pidFile = join(dir, 'worker.pid')
    process.env['FAKE_WORKER_PIDFILE'] = pidFile
    let workerPid = 0
    try {
      const serve = await spawnServe({
        configPath: 'unused.json',
        port: await allocateFreePort('127.0.0.1'),
        serveBinPath: fake.binPath,
        startTimeoutMs: 10_000
      })

      // The fake serve spawned a stubborn grandchild (the bare-worker analogue)
      // and recorded its pid before it began listening.
      workerPid = Number((await readFile(pidFile, 'utf8')).trim())
      assert.ok(workerPid > 0)
      assert.equal(isProcessAlive(serve.pid), true)
      assert.equal(isProcessAlive(workerPid), true)

      // Serve and worker both ignore SIGTERM, so teardown escalates to a SIGKILL
      // of the whole process GROUP. Without group signalling the worker (a
      // grandchild) would survive the serve and orphan.
      await stopServe(serve.child, 300)
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(isProcessAlive(serve.pid), false)
      assert.equal(
        isProcessAlive(workerPid),
        false,
        'bare-worker analogue must die with the serve group'
      )
    } finally {
      // Safety net so a regression (group-kill not reaching the worker) can't leak.
      if (workerPid > 0 && isProcessAlive(workerPid)) {
        try {
          process.kill(workerPid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
      delete process.env['FAKE_WORKER_PIDFILE']
      setBehavior(undefined)
      await rm(dir, { recursive: true, force: true })
      await fake.cleanup()
    }
  }
)
