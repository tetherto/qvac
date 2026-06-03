import assert from 'node:assert/strict'
import test from 'node:test'

import { createQvac } from '../src/provider.js'
import type { ManagedQvacProvider } from '../src/types.js'
import { fakeServeSkip as skip, makeFakeServe, setBehavior, withFakeHome } from './helpers/fake-serve.js'

test('createQvac (external) stays synchronous and unchanged', () => {
  const provider = createQvac({ baseURL: 'http://127.0.0.1:55555/v1' })
  assert.equal(typeof provider, 'function')
  assert.equal(typeof provider.chatModel, 'function')
  // External mode never resolves to a promise.
  assert.equal(typeof (provider as unknown as { then?: unknown }).then, 'undefined')
})

test('createQvac (managed) auto-spawns serve and returns a disposable provider', { skip }, async () => {
  await withFakeHome(async () => {
    const fake = await makeFakeServe()
    setBehavior('healthy')
    try {
      const provider: ManagedQvacProvider = await createQvac({
        mode: 'managed',
        models: ['QWEN3_600M_INST_Q4'],
        serveBinPath: fake.binPath,
        serveStartTimeout: 10_000
      })

      assert.equal(typeof provider, 'function')
      assert.equal(typeof provider.chatModel, 'function')
      assert.equal(typeof provider.close, 'function')
      assert.equal(typeof provider[Symbol.asyncDispose], 'function')
      assert.ok(provider.port > 0)
      assert.ok(provider.pid > 0)
      assert.equal(provider.baseURL, `http://127.0.0.1:${provider.port}/v1`)

      // The provider points at the live fake serve.
      const res = await fetch(`${provider.baseURL}/models`)
      assert.equal(res.status, 200)

      await provider.close()
    } finally {
      setBehavior(undefined)
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
    } finally {
      await fake.cleanup()
    }
  })
})
