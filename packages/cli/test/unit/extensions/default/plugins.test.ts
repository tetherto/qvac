import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import type { FastifyInstance } from 'fastify'
import { SDK_SERVER_ERROR_CODES } from '@qvac/sdk'
import { buildServer } from '@/serve/index'
import {
  pluginRoutes,
  type InvokeOptions,
  type PluginOperations
} from '@/serve/extensions/default/routes/plugins'

const URL = '/qvac/v1/plugins/echo-plugin/invoke'

interface Fake {
  calls: InvokeOptions[]
  result: unknown
  chunks: unknown[]
  pulled?: number
  error?: Error
  // Thrown after the chunks, so the SSE headers are already out.
  streamError?: Error
}

function fakeOperations(fake: Fake): PluginOperations {
  /* lunte-disable require-await */
  return {
    invoke: async (options) => {
      fake.calls.push(options)
      if (fake.error) throw fake.error
      return fake.result
    },
    invokeStream: async function* (options) {
      fake.calls.push(options)
      if (fake.error) throw fake.error
      for (const chunk of fake.chunks) {
        fake.pulled = (fake.pulled ?? 0) + 1
        yield chunk
      }
      if (fake.streamError) throw fake.streamError
    }
  }
  /* lunte-enable require-await */
}

function sdkError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code })
}

async function server(fake: Fake, enableAdmin: boolean): Promise<FastifyInstance> {
  const app = await buildServer({
    projectRoot: tmpdir(),
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    extensions: [],
    enableAdmin
  })
  await app.register(pluginRoutes(fakeOperations(fake)))
  await app.ready()
  const { registry } = app.qvac
  const opts = {
    modelSrc: 'x',
    sdkType: 'echo-plugin',
    endpointCategory: 'echo-plugin',
    config: {}
  }
  registry.register('echo', opts)
  registry.setReady('echo', 'sdk-echo')
  registry.register('chat', { ...opts, sdkType: 'llamacpp-completion', endpointCategory: 'chat' })
  registry.setReady('chat', 'sdk-chat')
  return app
}

function code(res: { json: () => unknown }): string {
  return (res.json() as { error: { code: string } }).error.code
}

function frames(payload: string): unknown[] {
  return payload
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => frame.slice('data: '.length))
    .map((data) => (data === '[DONE]' ? data : JSON.parse(data)))
}

describe('plugin invoke without --enable-admin', () => {
  const fake: Fake = { calls: [], result: null, chunks: [] }
  let app: FastifyInstance
  before(async () => {
    app = await server(fake, false)
  })
  after(async () => {
    await app.close()
  })

  it('refuses with 403 admin_disabled and never calls the plugin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: URL,
      payload: { model: 'echo', handler: 'ping' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(code(res), 'admin_disabled')
    assert.equal(fake.calls.length, 0)
  })
})

describe('plugin invoke with --enable-admin', () => {
  const fake: Fake = { calls: [], result: null, chunks: [] }
  let app: FastifyInstance
  before(async () => {
    app = await server(fake, true)
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    fake.calls = []
    fake.result = null
    fake.chunks = []
    delete fake.pulled
    delete fake.error
    delete fake.streamError
  })

  function invoke(payload: Record<string, unknown>, url = URL) {
    return app.inject({ method: 'POST', url, payload })
  }

  it('calls the handler on the loaded model and returns its result', async () => {
    fake.result = { echoed: 'hi' }
    const res = await invoke({ model: 'echo', handler: 'ping', params: { text: 'hi' } })
    assert.equal(res.statusCode, 200, res.payload)
    assert.deepEqual(res.json(), {
      object: 'plugin.invocation',
      model: 'echo',
      handler: 'ping',
      result: { echoed: 'hi' }
    })
    assert.deepEqual(fake.calls, [{ modelId: 'sdk-echo', handler: 'ping', params: { text: 'hi' } }])
  })

  it('sends {} when params is omitted', async () => {
    await invoke({ model: 'echo', handler: 'ping' })
    assert.deepEqual(fake.calls[0]?.params, {})
  })

  it('refuses a built-in plugin name, canonical or legacy', async () => {
    for (const name of ['llamacpp-completion', 'llm']) {
      const res = await invoke(
        { model: 'chat', handler: 'finetune' },
        `/qvac/v1/plugins/${name}/invoke`
      )
      assert.equal(res.statusCode, 400, name)
      assert.equal(code(res), 'builtin_plugin')
    }
    assert.equal(fake.calls.length, 0)
  })

  it('answers 404 model_not_found for an unknown alias', async () => {
    const res = await invoke({ model: 'nope', handler: 'ping' })
    assert.equal(res.statusCode, 404)
    assert.equal(code(res), 'model_not_found')
  })

  it('answers 400 invalid_model_type when the alias belongs to another plugin', async () => {
    const res = await invoke({ model: 'chat', handler: 'ping' })
    assert.equal(res.statusCode, 400)
    assert.equal(code(res), 'invalid_model_type')
    assert.equal(fake.calls.length, 0)
  })

  it('answers 400 missing_model without a model', async () => {
    const res = await invoke({ handler: 'ping' })
    assert.equal(res.statusCode, 400)
    assert.equal(code(res), 'missing_model')
  })

  it('trims model like the other model routes', async () => {
    const res = await invoke({ model: ' echo ', handler: 'ping' })
    assert.equal(res.statusCode, 200, res.payload)
    assert.equal(fake.calls[0]?.modelId, 'sdk-echo')
    const blank = await invoke({ model: '  ', handler: 'ping' })
    assert.equal(blank.statusCode, 400)
    assert.equal(code(blank), 'missing_model')
  })

  it('refuses unknown body fields', async () => {
    const res = await invoke({ model: 'echo', handler: 'ping', modelId: 'sdk-chat' })
    assert.equal(res.statusCode, 400)
    assert.equal(fake.calls.length, 0)
  })

  it('maps the SDK plugin errors to their own codes', async () => {
    const cases: [number, number, string][] = [
      [SDK_SERVER_ERROR_CODES.PLUGIN_HANDLER_NOT_FOUND, 404, 'handler_not_found'],
      [SDK_SERVER_ERROR_CODES.PLUGIN_REQUEST_VALIDATION_FAILED, 400, 'invalid_plugin_params'],
      [SDK_SERVER_ERROR_CODES.PLUGIN_HANDLER_TYPE_MISMATCH, 400, 'handler_type_mismatch'],
      [SDK_SERVER_ERROR_CODES.PLUGIN_RESPONSE_VALIDATION_FAILED, 502, 'plugin_response_invalid']
    ]
    for (const [sdkCode, status, httpCode] of cases) {
      fake.error = sdkError(sdkCode, `plugin said ${httpCode}`)
      const res = await invoke({ model: 'echo', handler: 'ping' })
      assert.equal(res.statusCode, status, httpCode)
      assert.equal(code(res), httpCode)
      assert.match(res.payload, new RegExp(`plugin said ${httpCode}`))
    }
  })

  it('answers 500 internal_error for any other failure, without its message', async () => {
    fake.error = new Error('segfault in the plugin')
    const res = await invoke({ model: 'echo', handler: 'ping' })
    assert.equal(res.statusCode, 500)
    assert.equal(code(res), 'internal_error')
    assert.doesNotMatch(res.payload, /segfault/)
  })

  it('streams chunks, then done, then [DONE]', async () => {
    fake.chunks = [{ n: 1 }, { n: 2 }]
    const res = await invoke({ model: 'echo', handler: 'count', stream: true })
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-type']), /text\/event-stream/)
    const base = { model: 'echo', handler: 'count' }
    assert.deepEqual(frames(res.payload), [
      { object: 'plugin.invocation.chunk', ...base, index: 0, result: { n: 1 } },
      { object: 'plugin.invocation.chunk', ...base, index: 1, result: { n: 2 } },
      { object: 'plugin.invocation.done', ...base },
      '[DONE]'
    ])
  })

  it('answers a stream that fails before its first chunk with a status, not SSE', async () => {
    fake.error = sdkError(SDK_SERVER_ERROR_CODES.PLUGIN_HANDLER_TYPE_MISMATCH, 'reply handler')
    const res = await invoke({ model: 'echo', handler: 'ping', stream: true })
    assert.equal(res.statusCode, 400)
    assert.equal(code(res), 'handler_type_mismatch')
  })

  it('ends a stream that fails mid-way with an SSE error frame', async () => {
    fake.chunks = [{ n: 1 }]
    fake.streamError = sdkError(
      SDK_SERVER_ERROR_CODES.PLUGIN_RESPONSE_VALIDATION_FAILED,
      'bad chunk'
    )
    const res = await invoke({ model: 'echo', handler: 'count', stream: true })
    assert.equal(res.statusCode, 200)
    const events = frames(res.payload)
    assert.deepEqual(events.at(-2), {
      error: { message: 'bad chunk', type: 'server_error', code: 'plugin_response_invalid' }
    })
    assert.equal(events.at(-1), '[DONE]')
  })

  it('stops pulling chunks while a slow client is not reading', async () => {
    fake.chunks = Array.from({ length: 200 }, () => ({ pad: 'x'.repeat(64 * 1024) }))
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    const req = request({
      port,
      host: '127.0.0.1',
      method: 'POST',
      path: URL,
      headers: { 'content-type': 'application/json' }
    })
    const paused = new Promise<void>((resolve) => {
      req.on('response', (res) => {
        res.pause()
        resolve()
      })
    })
    req.end(JSON.stringify({ model: 'echo', handler: 'count', stream: true }))
    await paused
    await sleep(200)
    const pulled = fake.pulled ?? 0
    req.destroy()
    assert.ok(pulled < fake.chunks.length, `pulled ${pulled} of ${fake.chunks.length}`)
  })
})
