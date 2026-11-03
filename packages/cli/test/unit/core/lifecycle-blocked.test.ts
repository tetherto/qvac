import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import type { FastifyInstance } from 'fastify'
import { SDK_SERVER_ERROR_CODES } from '@qvac/sdk'
import { buildServer } from '@/serve/index'
import { isLifecycleBlockedError } from '@/serve/core/lifecycle'
import { ensureReady } from '@/serve/core/plugins/require-model'
import { createLoadManager } from '@/serve/core/load-manager'
import { createModelRegistry } from '@/serve/core/model-registry'
import { createLogger } from '@/logger'

// Shaped like the RPC error the client rebuilds from the worker's envelope.
function blocked(): Error {
  return Object.assign(new Error('Operation "completionStream" blocked: runtime is suspended'), {
    name: 'LIFECYCLE_OPERATION_BLOCKED',
    code: SDK_SERVER_ERROR_CODES.LIFECYCLE_OPERATION_BLOCKED
  })
}

const MODEL = { modelSrc: 'x', sdkType: 'llm', endpointCategory: 'chat', config: {} }

function code(res: { json: () => unknown }): string {
  return (res.json() as { error: { code: string } }).error.code
}

describe('the SDK lifecycle gate', () => {
  it('is recognised directly and through a cause chain', () => {
    assert.equal(isLifecycleBlockedError(blocked()), true)
    assert.equal(isLifecycleBlockedError(new Error('load failed', { cause: blocked() })), true)
    assert.equal(isLifecycleBlockedError(new Error('other')), false)
    assert.equal(isLifecycleBlockedError(undefined), false)
  })
})

describe('a request that reaches the SDK after a suspend', () => {
  let app: FastifyInstance
  before(async () => {
    app = await buildServer({
      projectRoot: tmpdir(),
      port: 0,
      host: '127.0.0.1',
      quiet: true,
      extensions: [],
      loadModelOverride: () => Promise.reject(blocked())
    })
    // lunte-disable-next-line require-await
    app.get('/blocked', async () => {
      throw blocked()
    })
    // lunte-disable-next-line require-await
    app.get('/blocked-stream', async (_req, reply) => {
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' })
      reply.raw.write(': open\n\n')
      throw blocked()
    })
    app.get('/lazy', async (_req, reply) => {
      const entry = app.qvac.registry.register('lazy-llm', MODEL)
      await ensureReady(app.qvac, 'lazy-llm', entry, 'lazy-llm', reply)
      return { ok: true }
    })
    await app.ready()
  })
  after(async () => {
    await app.close()
  })

  it('answers 503 runtime_suspended instead of 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/blocked' })
    assert.equal(res.statusCode, 503)
    assert.equal(code(res), 'runtime_suspended')
  })

  it('ends a stream with a runtime_suspended event', async () => {
    const res = await app.inject({ method: 'GET', url: '/blocked-stream' })
    assert.match(res.payload, /"code":"runtime_suspended"/)
    assert.doesNotMatch(res.payload, /internal_error/)
  })

  it('answers 503 runtime_suspended for a lazy load and leaves the alias retriable', async () => {
    const res = await app.inject({ method: 'GET', url: '/lazy' })
    assert.equal(res.statusCode, 503)
    assert.equal(code(res), 'runtime_suspended')
    assert.equal(app.qvac.registry.getEntry('lazy-llm')?.state, app.qvac.registry.STATES.IDLE)
  })
})

describe('load manager', () => {
  it('leaves a load refused by the lifecycle gate unloaded, not errored', async () => {
    const reg = createModelRegistry()
    reg.register('m', MODEL)
    const mgr = createLoadManager(
      reg,
      createLogger('silent'),
      { concurrency: 1, timeoutMs: null },
      () => () => Promise.reject(blocked())
    )
    await assert.rejects(() => mgr.load('m'), isLifecycleBlockedError)
    assert.equal(reg.getEntry('m')?.state, reg.STATES.IDLE)
  })
})
