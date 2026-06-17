import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from './helpers/server.js'

// Phase-0 gate: the in-process harness builds a server and serves a request.
describe('e2e smoke', () => {
  it('serves /openapi.json in-process', async (t) => {
    const app = await createServer(t)
    const res = await app.inject({ method: 'GET', url: '/openapi.json' })
    assert.equal(res.statusCode, 200)
    const doc = JSON.parse(res.payload) as { openapi: string }
    assert.match(doc.openapi, /^3\./)
  })
})
