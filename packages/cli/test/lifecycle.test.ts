import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createModelRegistry } from '@/serve/core/model-registry'
import type { ResolvedModelEntry, ServeConfig } from '@/serve/core/model-registry'
import type { LoadManager } from '@/serve/core/load-manager'
import { preloadModels, formatErrorChain, shouldRefuseStart } from '@/serve/core/lifecycle'
import { createLogger } from '@/logger'

const logger = createLogger('silent')

function entry(alias: string, preload: boolean): ResolvedModelEntry {
  return {
    alias,
    modelSrc: `hyper://example.invalid/${alias}`,
    sdkType: 'llamacpp',
    endpointCategory: 'chat',
    isDefault: false,
    preload,
    config: {}
  }
}

function serveConfigWith(entries: ResolvedModelEntry[]): ServeConfig {
  return { models: new Map(entries.map((e) => [e.alias, e])) } as unknown as ServeConfig
}

function fakeLoadManager(failing: Set<string>): LoadManager {
  return {
    load: (alias: string) =>
      failing.has(alias) ? Promise.reject(new Error(`load failed: ${alias}`)) : Promise.resolve()
  } as unknown as LoadManager
}

describe('preloadModels', () => {
  it('reports nothing attempted when no model is marked preload', async () => {
    const cfg = serveConfigWith([entry('a', false)])
    const res = await preloadModels(cfg, createModelRegistry(), logger, fakeLoadManager(new Set()))
    assert.deepEqual(res, { attempted: 0, loaded: 0 })
  })

  it('reports zero loaded when every preload fails', async () => {
    const cfg = serveConfigWith([entry('a', true), entry('b', true)])
    const res = await preloadModels(
      cfg,
      createModelRegistry(),
      logger,
      fakeLoadManager(new Set(['a', 'b']))
    )
    assert.deepEqual(res, { attempted: 2, loaded: 0 })
  })

  it('counts the ones that loaded on a partial failure', async () => {
    const cfg = serveConfigWith([entry('a', true), entry('b', true)])
    const res = await preloadModels(
      cfg,
      createModelRegistry(),
      logger,
      fakeLoadManager(new Set(['a']))
    )
    assert.deepEqual(res, { attempted: 2, loaded: 1 })
  })
})

describe('shouldRefuseStart', () => {
  it('refuses when lazy is off and every preload failed', () => {
    assert.equal(shouldRefuseStart({ lazy: false }, { attempted: 2, loaded: 0 }), true)
  })

  it('starts when lazy is off but at least one preload loaded', () => {
    assert.equal(shouldRefuseStart({ lazy: false }, { attempted: 2, loaded: 1 }), false)
  })

  it('starts when lazy is off and nothing was preloaded', () => {
    assert.equal(shouldRefuseStart({ lazy: false }, { attempted: 0, loaded: 0 }), false)
  })

  it('starts when lazy is on even if every preload failed (retries on request)', () => {
    assert.equal(shouldRefuseStart({ lazy: true }, { attempted: 2, loaded: 0 }), false)
  })
})

describe('formatErrorChain', () => {
  it('joins a nested cause chain', () => {
    const err = new Error('top', { cause: new Error('mid', { cause: new Error('root') }) })
    assert.equal(formatErrorChain(err), 'top\n  caused by: mid\n  caused by: root')
  })

  it('renders a non-Error terminal cause', () => {
    const err = new Error('top', { cause: 'string root' })
    assert.equal(formatErrorChain(err), 'top\n  caused by: string root')
  })

  it('renders a non-Error input', () => {
    assert.equal(formatErrorChain('boom'), 'boom')
  })

  it('is cycle-safe', () => {
    const err = new Error('loop') as Error & { cause?: unknown }
    err.cause = err
    assert.equal(formatErrorChain(err), 'loop')
  })
})
