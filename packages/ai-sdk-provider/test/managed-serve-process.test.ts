import assert from 'node:assert/strict'
import test from 'node:test'

import { ServeExitedError, ServeStartTimeoutError } from '../src/managed/errors.js'
import { isProcessAlive } from '../src/managed/registry.js'
import { allocateFreePort, spawnServe, stopServe } from '../src/managed/serve-process.js'
import { fakeServeSkip as skip, makeFakeServe, setBehavior } from './helpers/fake-serve.js'

test('spawnServe brings up a healthy serve, reports coordinates, then stopServe terminates it', { skip }, async () => {
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
})

test('spawnServe throws ServeStartTimeoutError when the serve never gets healthy', { skip }, async () => {
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
})

test('spawnServe throws ServeExitedError when the serve exits before health', { skip }, async () => {
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
})

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
