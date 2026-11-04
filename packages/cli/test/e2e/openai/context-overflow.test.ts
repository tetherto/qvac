import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import type { FastifyInstance } from 'fastify'
import {
  ContextOverflowError,
  InferenceCancelledError,
  type CompletionEvent,
  type CompletionFinal,
  type CompletionRun
} from '@qvac/sdk'
import { createServer } from '../helpers/server.js'
import { collectSSE } from '../helpers/http.js'
import { bindClientDisconnectCancel } from '@/serve/core/cancel-bridge'

async function completionServer(
  t: TestContext,
  error?: Error,
  opts: { cancelled?: Promise<void>; configure?: (app: FastifyInstance) => void } = {}
) {
  const app = await createServer(t, {
    extensions: ['openai'],
    config: {
      serve: {
        models: {
          chat: {
            type: 'llamacpp-completion',
            src: 'hyper://example.invalid/chat',
            preload: false
          }
        }
      }
    }
  })
  // These runs are stubbed: no SDK inference exists to cancel if a bounded
  // regression request aborts because the server forgot to end its stream.
  app.addHook('onRequest', (req, _reply, done) => {
    req.bindCancel = () => {}
    done()
  })
  opts.configure?.(app)
  await app.ready()
  const entry = app.qvac.serveConfig.models.get('chat')!
  app.qvac.registry.register('chat', entry)
  app.qvac.registry.setReady('chat', 'sdk-chat')
  app.qvac.extensions.openai!.completionOverride = () => {
    // The SDK rejects the events iterator with the reconstructed typed error
    // when the worker's prefill fails, before any content delta can be emitted.
    async function* events(): AsyncGenerator<CompletionEvent> {
      if (error && !opts.cancelled) throw error
      yield { type: 'contentDelta', seq: 0, text: 'Synthetic answer' }
      await opts.cancelled
      yield { type: 'completionDone', seq: 1, stopReason: opts.cancelled ? 'cancelled' : 'eos' }
    }
    // Cancellation ends events normally, but rejects the SDK aggregates.
    const final: Promise<CompletionFinal> = opts.cancelled
      ? opts.cancelled.then(() => {
          throw error
        })
      : error
        ? Promise.reject(error)
        : Promise.resolve({
            contentText: 'Synthetic answer',
            toolCalls: [],
            raw: { fullText: 'Synthetic answer' },
            stopReason: 'eos'
          })
    const text = final.then((result) => result.contentText)
    const toolCalls = final.then((result) => result.toolCalls)
    const stats = final.then((result) => result.stats)
    // The SDK installs rejection handlers on its aggregate promises too;
    // a consumer draining only events must not cause unhandled rejections.
    for (const aggregate of [final, text, toolCalls, stats]) aggregate.catch(() => {})
    return {
      requestId: 'overflow-request',
      events: events(),
      final,
      text,
      toolCalls,
      stats,
      tokenStream: (async function* () {
        if (error) throw error
        yield 'Synthetic answer'
      })(),
      toolCallStream: (async function* (): AsyncGenerator<never> {
        if (error) throw error
      })()
    } satisfies CompletionRun
  }
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  return { app, address }
}

const ROUTES = [
  {
    url: '/v1/completions',
    input: { prompt: 'Synthetic meeting transcript' },
    sentinel: true
  },
  {
    url: '/v1/chat/completions',
    input: { messages: [{ role: 'user', content: 'Synthetic meeting transcript' }] },
    sentinel: true
  },
  {
    url: '/v1/responses',
    input: { input: 'Synthetic meeting transcript' },
    sentinel: false
  }
] as const

describe('serve: context overflow errors', () => {
  for (const route of ROUTES) {
    for (const stream of [false, true]) {
      it(`preserves typed overflow on ${route.url}, stream=${stream}`, async (t) => {
        const error = new ContextOverflowError(
          { promptTokens: 4097, ctxSize: 2048 },
          'sdk-chat',
          new Error('private native diagnostic')
        )
        const { app, address } = await completionServer(t, error)
        const loggedErrors: string[] = []
        app.qvac.logger.error = (message) => loggedErrors.push(message)
        const response = await fetch(`${address}${route.url}`, {
          method: 'POST',
          signal: AbortSignal.timeout(2000),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'chat', ...route.input, stream })
        })

        if (route.url === '/v1/responses') {
          assert.equal(response.headers.get('x-qvac-stub'), 'responses-volatile')
        }
        let body: { error: { code: string; type: string; message: string } }
        if (stream) {
          assert.equal(response.status, 200, 'SSE headers are already committed')
          const payload = await response.text()
          const events = collectSSE(payload)
          body = events.find(
            (event) =>
              event.data !== null && typeof event.data === 'object' && 'error' in event.data
          )?.data as typeof body
          assert.equal(
            events.some((event) => event.data === '[DONE]'),
            route.sentinel
          )
          assert.ok(!payload.includes('response.completed'))
        } else {
          assert.equal(response.status, 400)
          body = (await response.json()) as typeof body
        }

        assert.equal(body.error.code, 'context_length_exceeded')
        assert.equal(body.error.type, 'invalid_request_error')
        assert.match(body.error.message, /shorten.*input.*ctx_size/i)
        assert.ok(!body.error.message.includes('private native diagnostic'))
        assert.deepEqual(loggedErrors, [], 'expected input errors must not log native diagnostics')
      })
    }

    for (const stream of [false, true]) {
      it(`finishes successful ${route.url} replies, stream=${stream}`, async (t) => {
        const { address } = await completionServer(t)
        const response = await fetch(`${address}${route.url}`, {
          method: 'POST',
          signal: AbortSignal.timeout(2000),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'chat', ...route.input, stream })
        })
        const payload = await response.text()

        assert.equal(response.status, 200)
        assert.match(payload, /Synthetic answer/)
        if (route.url === '/v1/responses') {
          assert.equal(response.headers.get('x-qvac-stub'), 'responses-volatile')
        }
        if (stream) {
          const events = collectSSE(payload)
          assert.equal(
            events.some((event) => event.data === '[DONE]'),
            route.sentinel
          )
          if (route.url === '/v1/responses') assert.match(payload, /response.completed/)
        }
      })
    }

    it(`ends ${route.url} streams on untyped inference failures`, async (t) => {
      const { app, address } = await completionServer(t, new Error('private native diagnostic'))
      const loggedErrors: string[] = []
      app.qvac.logger.error = (message) => loggedErrors.push(message)
      const response = await fetch(`${address}${route.url}`, {
        method: 'POST',
        signal: AbortSignal.timeout(2000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'chat', ...route.input, stream: true })
      })
      const payload = await response.text()
      const events = collectSSE(payload)
      const failure = events.find(
        (event) => event.data !== null && typeof event.data === 'object' && 'error' in event.data
      )?.data as { error: { code: string; type: string; message: string } }

      assert.equal(response.status, 200)
      assert.equal(failure.error.code, 'internal_error')
      assert.equal(failure.error.type, 'server_error')
      assert.equal(failure.error.message, 'An internal error occurred.')
      assert.ok(!payload.includes('private native diagnostic'))
      assert.equal(loggedErrors.length, 1)
      assert.match(loggedErrors[0]!, /streaming_error.*\nError: private native diagnostic/)
      assert.equal(
        events.some((event) => event.data === '[DONE]'),
        route.sentinel
      )
    })

    for (const stream of [false, true]) {
      it(
        `ignores cancellation after disconnect on ${route.url}, stream=${stream}`,
        { timeout: 5000 },
        async (t) => {
          let cancel!: () => void
          const cancelled = new Promise<void>((resolve) => {
            cancel = resolve
          })
          let ready!: () => void
          const bound = new Promise<void>((resolve) => {
            ready = resolve
          })
          let onError!: (error: Error) => void
          const handled = new Promise<Error>((resolve) => {
            onError = resolve
          })
          const cancellation = new InferenceCancelledError('overflow-request', {
            text: 'Synthetic answer',
            toolCalls: []
          })
          const cancelledIds: string[] = []
          let writesAfterDisconnect = 0
          let endsAfterDisconnect = 0
          const { app, address } = await completionServer(t, cancellation, {
            cancelled,
            configure(app) {
              app.addHook('onRequest', (req, reply, done) => {
                reply.raw.once('close', () => {
                  t.mock.method(reply.raw, 'write', () => {
                    writesAfterDisconnect++
                    return false
                  })
                  t.mock.method(reply.raw, 'end', () => {
                    endsAfterDisconnect++
                    return reply.raw
                  })
                })
                req.bindCancel = (requestId) => {
                  bindClientDisconnectCancel(reply.raw, requestId, app.qvac.logger, (opts) => {
                    cancelledIds.push(opts.requestId)
                    cancel()
                    return Promise.resolve()
                  })
                  ready()
                }
                done()
              })
              app.addHook('onError', (_req, _reply, error, done) => {
                onError(error)
                done()
              })
            }
          })
          const loggedErrors: string[] = []
          app.qvac.logger.error = (message) => loggedErrors.push(message)
          const controller = new AbortController()
          t.after(() => controller.abort())
          const pendingResponse = fetch(`${address}${route.url}`, {
            method: 'POST',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'chat', ...route.input, stream })
          })
          pendingResponse.catch(() => {})
          await bound
          if (stream) {
            const response = await pendingResponse
            assert.equal(response.status, 200)
            assert.equal((await response.body!.getReader().read()).done, false)
          }
          controller.abort()
          if (!stream) await assert.rejects(pendingResponse, { name: 'AbortError' })
          assert.equal(await handled, cancellation)
          await setImmediate()
          assert.deepEqual(cancelledIds, ['overflow-request'])
          assert.deepEqual(loggedErrors, [])
          assert.equal(writesAfterDisconnect, 0)
          assert.equal(endsAfterDisconnect, 0)
        }
      )
    }
  }

  it('does not classify untyped errors by message text', async (t) => {
    const { address } = await completionServer(
      t,
      new Error('context overflow in an unrelated operation')
    )
    const response = await fetch(`${address}/v1/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'chat', messages: [{ role: 'user', content: 'hello' }] })
    })

    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), {
      error: {
        message: 'An internal error occurred.',
        type: 'server_error',
        code: 'internal_error'
      }
    })
  })

  it('recognizes overflow even when the worker has no context-size details', async (t) => {
    const { address } = await completionServer(t, new ContextOverflowError({}))
    const response = await fetch(`${address}/v1/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'chat', messages: [{ role: 'user', content: 'hello' }] })
    })
    const body = (await response.json()) as { error: { code: string } }

    assert.equal(response.status, 400)
    assert.equal(body.error.code, 'context_length_exceeded')
  })
})
