import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createModelRegistry } from '../src/serve/core/model-registry.js'
import { loadModel, type LoadModelFn } from '../src/serve/core/lifecycle.js'
import { createLogger } from '../src/logger.js'

const logger = createLogger('silent')

function register(registry: ReturnType<typeof createModelRegistry>, alias: string) {
  registry.register(alias, {
    modelSrc: `hyper://example.invalid/${alias}`,
    sdkType: 'llamacpp',
    endpointCategory: 'chat',
    config: {}
  })
}

describe('lifecycle.loadModel (lazy load)', () => {
  it('loads an idle model to READY via the override', async () => {
    const registry = createModelRegistry()
    register(registry, 'm')
    assert.equal(registry.getEntry('m')?.state, registry.STATES.IDLE)

    const load: LoadModelFn = () => Promise.resolve('sdk-id-1')
    await loadModel('m', registry, logger, load)

    const entry = registry.getEntry('m')
    assert.equal(entry?.state, registry.STATES.READY)
    assert.equal(entry?.sdkModelId, 'sdk-id-1')
  })

  it('dedups concurrent loads of the same alias into a single SDK load', async () => {
    const registry = createModelRegistry()
    register(registry, 'm')

    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const load: LoadModelFn = async () => {
      calls++
      await gate
      return 'sdk-id'
    }

    const p1 = loadModel('m', registry, logger, load)
    const p2 = loadModel('m', registry, logger, load)
    release?.()
    await Promise.all([p1, p2])

    assert.equal(calls, 1)
    assert.equal(registry.getEntry('m')?.state, registry.STATES.READY)
  })

  it('is a no-op when the model is already READY', async () => {
    const registry = createModelRegistry()
    register(registry, 'm')
    registry.setReady('m', 'sdk-id')

    let calls = 0
    const load: LoadModelFn = () => {
      calls++
      return Promise.resolve('other')
    }
    await loadModel('m', registry, logger, load)

    assert.equal(calls, 0)
    assert.equal(registry.getEntry('m')?.sdkModelId, 'sdk-id')
  })

  it('marks ERROR and rethrows on load failure, then retries on the next call', async () => {
    const registry = createModelRegistry()
    register(registry, 'm')

    let attempt = 0
    const load: LoadModelFn = () => {
      attempt++
      if (attempt === 1) return Promise.reject(new Error('boom'))
      return Promise.resolve('sdk-id-2')
    }

    await assert.rejects(() => loadModel('m', registry, logger, load), /boom/)
    assert.equal(registry.getEntry('m')?.state, registry.STATES.ERROR)

    await loadModel('m', registry, logger, load)
    assert.equal(registry.getEntry('m')?.state, registry.STATES.READY)
    assert.equal(attempt, 2)
  })

  it('reloads after markUnloaded (the DELETE reload path)', async () => {
    const registry = createModelRegistry()
    register(registry, 'm')

    const load: LoadModelFn = () => Promise.resolve('sdk-id-a')
    await loadModel('m', registry, logger, load)
    assert.equal(registry.getEntry('m')?.state, registry.STATES.READY)

    registry.markUnloaded('m')
    const after = registry.getEntry('m')
    assert.equal(after?.state, registry.STATES.IDLE)
    assert.equal(after?.sdkModelId, null)

    const reload: LoadModelFn = () => Promise.resolve('sdk-id-b')
    await loadModel('m', registry, logger, reload)
    assert.equal(registry.getEntry('m')?.state, registry.STATES.READY)
    assert.equal(registry.getEntry('m')?.sdkModelId, 'sdk-id-b')
  })
})
