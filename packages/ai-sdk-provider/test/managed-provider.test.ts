import assert from 'node:assert/strict'
import test from 'node:test'

import { createQvac } from '../src/provider.js'
import { isProcessAlive, readAllRecords } from '../src/managed/registry.js'
import type { ManagedQvacProvider } from '../src/types.js'
import { fakeServeSkip as skip, makeFakeServe, reapAllManaged, setBehavior, withFakeHome } from './helpers/fake-serve.js'

test('createQvac (external) stays synchronous and unchanged', () => {
  const provider = createQvac({ baseURL: 'http://127.0.0.1:55555/v1' })
  assert.equal(typeof provider, 'function')
  assert.equal(typeof provider.chatModel, 'function')
  // External mode never resolves to a promise.
  assert.equal(typeof (provider as unknown as { then?: unknown }).then, 'undefined')
})

test('createQvac (managed) auto-spawns a serve and returns a disposable provider', { skip }, async () => {
  await withFakeHome(async () => {
    const fake = await makeFakeServe()
    setBehavior('healthy')
    try {
      const provider: ManagedQvacProvider = await createQvac({
        mode: 'managed',
        models: ['QWEN3_600M_INST_Q4'],
        serveBinPath: fake.binPath,
        serveStartTimeout: 15_000
      })

      assert.equal(typeof provider, 'function')
      assert.equal(typeof provider.chatModel, 'function')
      assert.equal(typeof provider.close, 'function')
      assert.equal(typeof provider[Symbol.asyncDispose], 'function')
      assert.ok(provider.port > 0)
      assert.ok(provider.pid > 0)
      assert.equal(provider.baseURL, `http://127.0.0.1:${provider.port}/v1`)

      // The provider points at the live (detached-runner-owned) fake serve.
      const res = await fetch(`${provider.baseURL}/models`)
      assert.equal(res.status, 200)

      // close() only detaches — the serve keeps running for other consumers.
      await provider.close()
      assert.equal(isProcessAlive(provider.pid), true)
    } finally {
      setBehavior(undefined)
      await reapAllManaged()
      await fake.cleanup()
    }
  })
})

test('createQvac (managed) reuses a matching shared serve instead of spawning a second', { skip }, async () => {
  await withFakeHome(async () => {
    const fake = await makeFakeServe()
    setBehavior('healthy')
    try {
      const a = await createQvac({ mode: 'managed', models: ['QWEN3_600M_INST_Q4'], serveBinPath: fake.binPath, serveStartTimeout: 15_000 })
      const b = await createQvac({ mode: 'managed', models: ['QWEN3_600M_INST_Q4'], serveBinPath: fake.binPath, serveStartTimeout: 15_000 })

      // Same fleet key → same underlying serve process and port.
      assert.equal(b.pid, a.pid)
      assert.equal(b.port, a.port)

      // Exactly one serve is recorded for the shared fleet.
      const records = await readAllRecords()
      assert.equal(records.length, 1)

      await a.close()
      await b.close()
    } finally {
      setBehavior(undefined)
      await reapAllManaged()
      await fake.cleanup()
    }
  })
})

test('managed runner reaps the serve once no consumer remains for the idle timeout', { skip }, async () => {
  await withFakeHome(async () => {
    const fake = await makeFakeServe()
    setBehavior('healthy')
    try {
      const provider = await createQvac({
        mode: 'managed',
        models: ['QWEN3_600M_INST_Q4'],
        serveBinPath: fake.binPath,
        serveStartTimeout: 15_000,
        serveIdleTimeout: 800
      })
      const pid = provider.pid
      assert.equal(isProcessAlive(pid), true)

      // Detach: with no live consumer the runner should reap within
      // idleTimeout + one poll interval.
      await provider.close()

      const deadline = Date.now() + 12_000
      while (Date.now() < deadline && isProcessAlive(pid)) {
        await new Promise((r) => setTimeout(r, 200))
      }
      assert.equal(isProcessAlive(pid), false, 'serve should have been idle-reaped')
      assert.deepEqual(await readAllRecords(), [], 'record should be gone after reap')
    } finally {
      setBehavior(undefined)
      await reapAllManaged()
      await fake.cleanup()
    }
  })
})

test('createQvac (managed) rejects an unknown model before spawning anything', { skip }, async () => {
  await withFakeHome(async () => {
    const fake = await makeFakeServe()
    try {
      await assert.rejects(
        createQvac({
          mode: 'managed',
          models: ['DEFINITELY_NOT_A_MODEL'],
          serveBinPath: fake.binPath
        }),
        /Unknown QVAC model constant/
      )
      assert.deepEqual(await readAllRecords(), [])
    } finally {
      await reapAllManaged()
      await fake.cleanup()
    }
  })
})
