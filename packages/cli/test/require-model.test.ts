import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { FastifyRequest } from 'fastify'
import { createModelRegistry } from '../src/serve/core/model-registry.js'
import {
  createLoadManager,
  type LoadManagerDeps,
  type LoadModelFn
} from '../src/serve/core/load-manager.js'
import { ensureReady } from '../src/serve/plugins/require-model.js'
import { createLogger } from '../src/logger.js'
import type { QvacContext } from '../src/serve/lib/types.js'
import { HttpError } from '../src/serve/lib/http-error.js'

const logger = createLogger('silent')

const CONFIG_ENTRY = {
  alias: 'm',
  modelSrc: 'hyper://example.invalid/m',
  sdkType: 'llamacpp',
  endpointCategory: 'chat',
  isDefault: false,
  preload: false,
  config: {}
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makeCtx(loadFn: LoadModelFn, deps: LoadManagerDeps, cancelOnDisconnect: boolean) {
  const registry = createModelRegistry()
  const loadManager = createLoadManager(
    registry,
    logger,
    { concurrency: 4, timeoutMs: null },
    () => loadFn,
    deps
  )
  const serveConfig = {
    load: { lazy: true, concurrency: 4, timeoutMs: null, cancelOnDisconnect }
  }
  return { registry, loadManager, serveConfig, logger } as unknown as QvacContext
}

function fakeReq() {
  const raw = new EventEmitter()
  return { req: { raw } as unknown as FastifyRequest, raw }
}

describe('ensureReady disconnect handling', () => {
  it('cancels the in-flight load when the client disconnects mid-load', async () => {
    const gate = deferred<string>()
    const loadFn: LoadModelFn = () => {
      const p = gate.promise as Promise<string> & { requestId?: string }
      p.requestId = 'req-d'
      return p
    }
    let cancelledWith: string | null = null
    const ctx = makeCtx(
      loadFn,
      {
        cancel: (rid) => {
          cancelledWith = rid
          return Promise.resolve()
        },
        unload: () => Promise.resolve()
      },
      true
    )
    const { req, raw } = fakeReq()

    const settled = ensureReady(ctx, 'm', CONFIG_ENTRY, 'm', req).catch((e) => e)
    await new Promise((r) => setTimeout(r, 0))
    raw.emit('close') // client disconnects

    assert.equal(cancelledWith, 'req-d')
    gate.resolve('sdk-late')
    const err = await settled
    assert.ok(err instanceof HttpError)
    assert.equal(err.code, 'model_load_failed')
  })

  it('keeps loading when cancelOnDisconnect is false', async () => {
    const gate = deferred<string>()
    const loadFn: LoadModelFn = () => {
      const p = gate.promise as Promise<string> & { requestId?: string }
      p.requestId = 'req-n'
      return p
    }
    let cancelCalled = false
    const ctx = makeCtx(
      loadFn,
      {
        cancel: () => {
          cancelCalled = true
          return Promise.resolve()
        },
        unload: () => Promise.resolve()
      },
      false
    )
    const { req, raw } = fakeReq()

    const settled = ensureReady(ctx, 'm', CONFIG_ENTRY, 'm', req)
    await new Promise((r) => setTimeout(r, 0))
    raw.emit('close') // disconnect ignored — load continues
    gate.resolve('sdk-ok')

    const entry = await settled
    assert.equal(cancelCalled, false)
    assert.equal(entry.state, ctx.registry.STATES.READY)
  })
})
