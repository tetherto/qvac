import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from '../helpers/server.js'

describe('qvac kv_cache: surface', () => {
  const server = useServer()

  it('advertises DELETE and the response shape it returns', async () => {
    const res = await server().inject({ method: 'GET', url: '/openapi.json' })

    assert.equal(res.statusCode, 200)
    const doc = res.json() as {
      paths: Record<
        string,
        Record<
          string,
          { tags?: string[]; responses?: Record<string, { content?: Record<string, unknown> }> }
        >
      >
    }
    const operation = doc.paths['/qvac/v1/kv_cache']?.['delete']
    assert.notEqual(operation, undefined, 'kv_cache has no DELETE in openapi.json')
    assert.deepEqual(operation?.tags, ['KV Cache'], 'DELETE is grouped under the KV Cache tag')

    // The published 200 schema is the endpoint's contract, so pin it rather than
    // the mere presence of an operation.
    assert.deepEqual(operation?.responses?.['200']?.content?.['application/json'], {
      schema: {
        type: 'object',
        properties: {
          object: { type: 'string', enum: ['kv_cache.reclaim'] },
          deleted: { type: 'boolean', enum: [true] }
        },
        required: ['object', 'deleted'],
        additionalProperties: false
      }
    })
  })
})

describe('qvac kv_cache: not mounted without the QVAC surface', () => {
  const server = useServer({ extensions: ['openai'] })

  it('returns 404', async () => {
    const res = await server().inject({ method: 'DELETE', url: '/qvac/v1/kv_cache' })

    assert.equal(res.statusCode, 404)
  })
})
