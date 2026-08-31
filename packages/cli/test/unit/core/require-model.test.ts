import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { createModelRegistry } from '@/serve/core/model-registry'
import {
  createLoadManager,
  type LoadManagerDeps,
  type LoadModelFn
} from '@/serve/core/load-manager'
import { ensureReady, resolveAndCheckModel } from '@/serve/plugins/require-model'
import { createLogger } from '@/logger'
import type { QvacContext } from '@/serve/lib/types'
import { HttpError } from '@/serve/lib/http-error'

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
    models: new Map([['m', CONFIG_ENTRY]]),
    load: { lazy: true, concurrency: 4, timeoutMs: null, cancelOnDisconnect }
  }
  return { registry, loadManager, serveConfig, logger } as unknown as QvacContext
}

function fakeReply() {
  const raw = new EventEmitter()
  return { reply: { raw } as unknown as FastifyReply, raw }
}

// A request and a reply backed by separate streams, so a test can tell which
// one the disconnect signal is bound to.
function fakeExchange(ctx: QvacContext) {
  const reqRaw = new EventEmitter()
  const replyRaw = new EventEmitter()
  return {
    req: { raw: reqRaw, server: { qvac: ctx } } as unknown as FastifyRequest,
    reply: { raw: replyRaw } as unknown as FastifyReply,
    reqRaw,
    replyRaw
  }
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
    const { reply, raw } = fakeReply()

    const settled = ensureReady(ctx, 'm', CONFIG_ENTRY, 'm', reply).catch((e) => e)
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
    const { reply, raw } = fakeReply()

    const settled = ensureReady(ctx, 'm', CONFIG_ENTRY, 'm', reply)
    await new Promise((r) => setTimeout(r, 0))
    raw.emit('close') // disconnect ignored — load continues
    gate.resolve('sdk-ok')

    const entry = await settled
    assert.equal(cancelCalled, false)
    assert.equal(entry.state, ctx.registry.STATES.READY)
  })
})

// `ensureReady` aborts on whatever stream it is handed; which one that is gets
// decided here. These cases pass a distinct request and reply stream so the
// choice is observable.
describe('resolveAndCheckModel disconnect wiring', () => {
  function gatedCtx(requestId: string, cancelOnDisconnect = true) {
    const gate = deferred<string>()
    const loadFn: LoadModelFn = () => {
      const p = gate.promise as Promise<string> & { requestId?: string }
      p.requestId = requestId
      return p
    }
    const cancelled: { rid: string | null } = { rid: null }
    const ctx = makeCtx(
      loadFn,
      {
        cancel: (rid) => {
          cancelled.rid = rid
          return Promise.resolve()
        },
        unload: () => Promise.resolve()
      },
      cancelOnDisconnect
    )
    return { ctx, gate, cancelled }
  }

  it('ignores request-stream close, which Fastify fires once the body is read', async () => {
    const { ctx, gate, cancelled } = gatedCtx('req-body')
    const { req, reply, reqRaw } = fakeExchange(ctx)

    const settled = resolveAndCheckModel(req, reply, 'm', 'chat')
    await new Promise((r) => setTimeout(r, 0))
    reqRaw.emit('close')

    assert.equal(cancelled.rid, null, 'end of the request body must not cancel the load')
    gate.resolve('sdk-ok')

    const model = await settled
    assert.equal(model.entry.state, ctx.registry.STATES.READY)
  })

  it('cancels on reply-stream close, which marks a real client disconnect', async () => {
    const { ctx, gate, cancelled } = gatedCtx('reply-drop')
    const { req, reply, replyRaw } = fakeExchange(ctx)

    const settled = resolveAndCheckModel(req, reply, 'm', 'chat').catch((e) => e)
    await new Promise((r) => setTimeout(r, 0))
    replyRaw.emit('close')

    assert.equal(cancelled.rid, 'reply-drop')
    gate.resolve('sdk-late')

    const err = await settled
    assert.ok(err instanceof HttpError)
    assert.equal(err.code, 'model_load_failed')
  })
})
