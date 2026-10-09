import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import {
  ContextOverflowError,
  type CompletionEvent,
  type CompletionFinal,
  type CompletionRun
} from '@qvac/sdk'
import { createServer } from '../helpers/server.js'
import { collectSSE } from '../helpers/http.js'

async function completionServer(t: TestContext, error?: Error) {
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
  await app.ready()
  const entry = app.qvac.serveConfig.models.get('chat')!
  app.qvac.registry.register('chat', entry)
  app.qvac.registry.setReady('chat', 'sdk-chat')
  app.qvac.extensions.openai!.completionOverride = () => {
    // The SDK rejects the events iterator with the reconstructed typed error
    // when the worker's prefill fails, before any content delta can be emitted.
    async function* events(): AsyncGenerator<CompletionEvent> {
      if (error) throw error
      yield { type: 'contentDelta', seq: 0, text: 'Synthetic answer' }
      yield { type: 'completionDone', seq: 1, stopReason: 'eos' }
    }
    const final: Promise<CompletionFinal> = error
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
      const { address } = await completionServer(t, new Error('synthetic inference failure'))
      const response = await fetch(`${address}${route.url}`, {
        method: 'POST',
        signal: AbortSignal.timeout(2000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'chat', ...route.input, stream: true })
      })
      const events = collectSSE(await response.text())
      const failure = events.find(
        (event) => event.data !== null && typeof event.data === 'object' && 'error' in event.data
      )?.data as { error: { code: string; type: string } }

      assert.equal(failure.error.code, 'internal_error')
      assert.equal(failure.error.type, 'server_error')
      assert.equal(
        events.some((event) => event.data === '[DONE]'),
        route.sentinel
      )
    })
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
