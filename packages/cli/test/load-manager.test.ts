import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createModelRegistry } from '../src/serve/core/model-registry.js'
import {
  createLoadManager,
  ModelLoadTimeoutError,
  type LoadModelFn
} from '../src/serve/core/load-manager.js'
import { createLogger } from '../src/logger.js'

const logger = createLogger('silent')

function registry(...aliases: string[]) {
  const reg = createModelRegistry()
  for (const alias of aliases) {
    reg.register(alias, {
      modelSrc: `hyper://example.invalid/${alias}`,
      sdkType: 'llamacpp',
      endpointCategory: 'chat',
      config: {}
    })
  }
  return reg
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const OPTS = { concurrency: 4, timeoutMs: null }

describe('load-manager', () => {
  it('loads an idle model to READY', async () => {
    const reg = registry('m')
    const mgr = createLoadManager(reg, logger, OPTS, () => () => Promise.resolve('sdk-1'))
    await mgr.load('m')
    assert.equal(reg.getEntry('m')?.state, reg.STATES.READY)
    assert.equal(reg.getEntry('m')?.sdkModelId, 'sdk-1')
  })

  it('dedups concurrent loads of the same alias into one SDK load', async () => {
    const reg = registry('m')
    let calls = 0
    const gate = deferred<string>()
    const load: LoadModelFn = () => {
      calls++
      return gate.promise
    }
    const mgr = createLoadManager(reg, logger, OPTS, () => load)
    const p1 = mgr.load('m')
    const p2 = mgr.load('m')
    gate.resolve('sdk')
    await Promise.all([p1, p2])
    assert.equal(calls, 1)
    assert.equal(reg.getEntry('m')?.state, reg.STATES.READY)
  })

  it('limits concurrency across distinct aliases', async () => {
    const reg = registry('a', 'b', 'c')
    let active = 0
    let peak = 0
    const gates: Record<string, ReturnType<typeof deferred<string>>> = {
      a: deferred(),
      b: deferred(),
      c: deferred()
    }
    const loadFn: LoadModelFn = (opts) => {
      const alias = String(opts.modelSrc).split('/').pop()!
      active++
      peak = Math.max(peak, active)
      return gates[alias]!.promise.then((v) => {
        active--
        return v
      })
    }
    const mgr = createLoadManager(reg, logger, { concurrency: 2, timeoutMs: null }, () => loadFn)
    const pa = mgr.load('a')
    const pb = mgr.load('b')
    const pc = mgr.load('c')
    // a and b run; c is queued behind the concurrency=2 cap.
    await Promise.resolve()
    assert.ok(peak <= 2, `peak concurrency ${peak} should not exceed 2`)
    gates.a!.resolve('sa')
    gates.b!.resolve('sb')
    gates.c!.resolve('sc')
    await Promise.all([pa, pb, pc])
    assert.equal(peak, 2)
    assert.equal(reg.getEntry('c')?.state, reg.STATES.READY)
  })

  it('times out a slow load, cancels it, and marks ERROR', async () => {
    const reg = registry('m')
    const never = deferred<string>()
    const mgr = createLoadManager(
      reg,
      logger,
      { concurrency: 1, timeoutMs: 20 },
      () => () => never.promise
    )
    await assert.rejects(() => mgr.load('m'), ModelLoadTimeoutError)
    assert.equal(reg.getEntry('m')?.state, reg.STATES.ERROR)
  })

  it('marks ERROR and rethrows on load failure, then retries next call', async () => {
    const reg = registry('m')
    let attempt = 0
    const load: LoadModelFn = () => {
      attempt++
      return attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('sdk-2')
    }
    const mgr = createLoadManager(reg, logger, OPTS, () => load)
    await assert.rejects(() => mgr.load('m'), /boom/)
    assert.equal(reg.getEntry('m')?.state, reg.STATES.ERROR)
    await mgr.load('m')
    assert.equal(reg.getEntry('m')?.state, reg.STATES.READY)
    assert.equal(attempt, 2)
  })

  it('does not cancel a shared load while another caller still waits', async () => {
    const reg = registry('m')
    const gate = deferred<string>()
    const mgr = createLoadManager(reg, logger, OPTS, () => () => gate.promise)
    const acA = new AbortController()
    const acB = new AbortController()
    const pA = mgr.load('m', acA.signal)
    const pB = mgr.load('m', acB.signal)
    acA.abort() // A leaves; B still waiting → load must continue
    gate.resolve('sdk')
    await Promise.all([pA, pB])
    assert.equal(reg.getEntry('m')?.state, reg.STATES.READY)
  })

  it('isLoading reflects an in-flight load and clears on settle', async () => {
    const reg = registry('m')
    const gate = deferred<string>()
    const mgr = createLoadManager(reg, logger, OPTS, () => () => gate.promise)
    const p = mgr.load('m')
    assert.equal(mgr.isLoading('m'), true)
    gate.resolve('sdk')
    await p
    assert.equal(mgr.isLoading('m'), false)
  })

  it('settled resolves even when the load fails', async () => {
    const reg = registry('m')
    const mgr = createLoadManager(reg, logger, OPTS, () => () => Promise.reject(new Error('x')))
    const p = mgr.load('m').catch(() => {})
    await mgr.settled('m')
    await p
    assert.equal(reg.getEntry('m')?.state, reg.STATES.ERROR)
  })
})
