import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from '../helpers/server.js'

function code(res: { json: () => unknown }): string {
  return (res.json() as { error: { code: string } }).error.code
}

describe('qvac runtime: without --enable-admin', () => {
  const server = useServer()

  it('lists no loaded models on a modelless server', async () => {
    const res = await server().inject({ method: 'GET', url: '/qvac/v1/runtime/models' })
    assert.deepEqual(res.json(), { object: 'list', data: [] })
  })

  it('refuses suspend and resume with 403 admin_disabled', async () => {
    for (const url of ['/qvac/v1/runtime/suspend', '/qvac/v1/runtime/resume']) {
      const res = await server().inject({ method: 'POST', url })
      assert.equal(res.statusCode, 403, url)
      assert.equal(code(res), 'admin_disabled')
    }
  })

  it('lists every error code in openapi.json', async () => {
    const doc = (await server().inject({ method: 'GET', url: '/openapi.json' })).json() as {
      paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>>
    }
    const suspend = doc.paths['/qvac/v1/runtime/suspend']?.['post']?.responses
    assert.match(suspend?.['403']?.description ?? '', /admin_disabled/)
    assert.match(suspend?.['500']?.description ?? '', /runtime_suspend_failed/)
    const models = doc.paths['/qvac/v1/runtime/models']?.['get']?.responses
    assert.match(models?.['503']?.description ?? '', /runtime_suspended/)
  })
})

describe('qvac runtime: not mounted without the QVAC surface', () => {
  const server = useServer({ extensions: ['openai'] })

  it('returns 404', async () => {
    const res = await server().inject({ method: 'GET', url: '/qvac/v1/runtime/state' })
    assert.equal(res.statusCode, 404)
  })
})
