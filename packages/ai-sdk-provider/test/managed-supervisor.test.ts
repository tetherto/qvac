import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { ServeExitedError, ServeStartTimeoutError } from '../src/managed/errors.js'
import { isProcessAlive } from '../src/managed/pid-tracker.js'
import { startServeSupervisor } from '../src/managed/supervisor.js'
import { fakeServeSkip as skip, makeFakeServe, setBehavior, withFakeHome } from './helpers/fake-serve.js'

test('supervisor spawns a healthy serve, reports coordinates, then stops cleanly', { skip }, async () => {
  await withFakeHome(async () => {
    const fake = await makeFakeServe()
    setBehavior('healthy')
    try {
      const sup = await startServeSupervisor({
        models: ['QWEN3_600M_INST_Q4'],
        configPath: join(fake.binPath, '..', 'qvac.config.json'),
        serveBinPath: fake.binPath,
        startTimeoutMs: 10_000
      })

      assert.ok(sup.port > 0)
      assert.ok(sup.pid > 0)
      assert.match(sup.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
      assert.equal(isProcessAlive(sup.pid), true)

      // The /v1/models endpoint really answers.
      const res = await fetch(`${sup.baseURL}/models`)
      assert.equal(res.status, 200)

      await sup.stop()
      // Give the OS a beat to reap the process.
      await new Promise((r) => setTimeout(r, 200))
      assert.equal(isProcessAlive(sup.pid), false)

      // stop() is idempotent.
      await sup.stop()
    } finally {
      setBehavior(undefined)
      await fake.cleanup()
    }
  })
})

test('supervisor honours an explicit port', { skip }, async () => {
  await withFakeHome(async () => {
    const fake = await makeFakeServe()
    setBehavior('healthy')
    try {
      // Pick a high, likely-free port deterministically for the assertion.
      const port = 28_734
      const sup = await startServeSupervisor({
        models: ['QWEN3_600M_INST_Q4'],
        configPath: 'unused.json',
        serveBinPath: fake.binPath,
        port,
        startTimeoutMs: 10_000
      })
      try {
        assert.equal(sup.port, port)
        assert.equal(sup.baseURL, `http://127.0.0.1:${port}/v1`)
      } finally {
        await sup.stop()
      }
    } finally {
      setBehavior(undefined)
      await fake.cleanup()
    }
  })
})

test('supervisor throws ServeStartTimeoutError when the serve never gets healthy', { skip }, async () => {
  await withFakeHome(async () => {
    const fake = await makeFakeServe()
    setBehavior('never-listen')
    try {
      await assert.rejects(
        startServeSupervisor({
          models: ['QWEN3_600M_INST_Q4'],
          configPath: 'unused.json',
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
  })
})

test('supervisor throws ServeExitedError when the serve exits before health', { skip }, async () => {
  await withFakeHome(async () => {
    const fake = await makeFakeServe()
    setBehavior('exit-immediately')
    try {
      await assert.rejects(
        startServeSupervisor({
          models: ['QWEN3_600M_INST_Q4'],
          configPath: 'unused.json',
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
  })
})

test('supervisor escalates to SIGKILL when SIGTERM is ignored', { skip }, async () => {
  await withFakeHome(async () => {
    const fake = await makeFakeServe()
    setBehavior('ignore-sigterm')
    try {
      const sup = await startServeSupervisor({
        models: ['QWEN3_600M_INST_Q4'],
        configPath: 'unused.json',
        serveBinPath: fake.binPath,
        startTimeoutMs: 10_000,
        shutdownGraceMs: 300
      })
      assert.equal(isProcessAlive(sup.pid), true)

      await sup.stop()
      await new Promise((r) => setTimeout(r, 200))
      assert.equal(isProcessAlive(sup.pid), false)
    } finally {
      setBehavior(undefined)
      await fake.cleanup()
    }
  })
})
