import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { initSSE, sendSSE, endSSE } from '../../src/serve/lib/sse.js'
import { collectSSE, multipart, assertError, type InjectResponse } from './helpers/http.js'

// Harness self-tests. The SSE case confirms app.inject captures hijacked
// reply.raw writes, so streaming routes can be tested in-process.
describe('e2e harness helpers', () => {
  it('collectSSE parses hijacked reply.raw SSE captured by app.inject', { timeout: 5000 }, async () => {
    const app = Fastify({ logger: false })
    app.get('/sse', async (_req, reply) => {
      initSSE(reply)
      sendSSE(reply.raw, { a: 1 })
      sendSSE(reply.raw, { b: 2 })
      endSSE(reply.raw)
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/sse' })
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-type']), /text\/event-stream/)
    assert.deepEqual(collectSSE(res.payload).map((e) => e.data), [{ a: 1 }, { b: 2 }, '[DONE]'])

    await app.close()
  })

  it('multipart builds a parseable form-data body', () => {
    const { payload, headers } = multipart([
      { name: 'model', value: 'whisper' },
      { name: 'file', filename: 'a.wav', contentType: 'audio/wav', data: Buffer.from('RIFF') }
    ])
    assert.match(headers['content-type'], /multipart\/form-data; boundary=/)
    assert.ok(payload.includes('name="model"'))
    assert.ok(payload.includes('filename="a.wav"'))
  })

  it('assertError matches an OpenAI-style error envelope', () => {
    const fake = { json: () => ({ error: { code: 'missing_model', message: 'no model' } }), payload: '' }
    assertError(fake as unknown as InjectResponse, 'missing_model')
  })
})
