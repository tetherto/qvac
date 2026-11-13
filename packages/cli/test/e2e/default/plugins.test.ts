import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from '../helpers/server.js'

const URL = '/qvac/v1/plugins/echo-plugin/invoke'

function code(res: { json: () => unknown }): string {
  return (res.json() as { error: { code: string } }).error.code
}

describe('qvac plugins: without --enable-admin', () => {
  const server = useServer()

  it('refuses invoke with 403 admin_disabled', async () => {
    const res = await server().inject({
      method: 'POST',
      url: URL,
      payload: { model: 'echo', handler: 'ping' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(code(res), 'admin_disabled')
  })

  it('lists every error code in openapi.json', async () => {
    const doc = (await server().inject({ method: 'GET', url: '/openapi.json' })).json() as {
      paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>>
    }
    const responses = doc.paths['/qvac/v1/plugins/{name}/invoke']?.['post']?.responses
    assert.match(responses?.['400']?.description ?? '', /missing_model[\s\S]*builtin_plugin/)
    assert.match(responses?.['403']?.description ?? '', /admin_disabled/)
    assert.match(responses?.['404']?.description ?? '', /handler_not_found/)
    assert.match(responses?.['502']?.description ?? '', /plugin_response_invalid/)
    assert.match(responses?.['503']?.description ?? '', /model_load_failed/)
  })
})

describe('qvac plugins: with --enable-admin', () => {
  const server = useServer({ enableAdmin: true })

  it('answers 400 missing_handler without a handler', async () => {
    const res = await server().inject({ method: 'POST', url: URL, payload: { model: 'echo' } })
    assert.equal(res.statusCode, 400)
    assert.equal(code(res), 'missing_handler')
  })

  it('refuses a built-in plugin', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/plugins/llamacpp-completion/invoke',
      payload: { model: 'echo', handler: 'finetune' }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(code(res), 'builtin_plugin')
  })

  it('answers 404 model_not_found for an alias that is not configured', async () => {
    const res = await server().inject({
      method: 'POST',
      url: URL,
      payload: { model: 'echo', handler: 'ping' }
    })
    assert.equal(res.statusCode, 404)
    assert.equal(code(res), 'model_not_found')
  })
})

describe('qvac plugins: not mounted without the QVAC surface', () => {
  const server = useServer({ extensions: ['openai'], enableAdmin: true })

  it('returns 404', async () => {
    const res = await server().inject({
      method: 'POST',
      url: URL,
      payload: { model: 'echo', handler: 'ping' }
    })
    assert.equal(res.statusCode, 404)
    assert.equal(code(res), 'not_found')
  })
})
