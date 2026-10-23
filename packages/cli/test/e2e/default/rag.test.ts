import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from '../helpers/server.js'
import { JSON_HEADERS, assertStatusAndError } from '../helpers/http.js'

const RAG_CONFIG = {
  serve: {
    models: {
      'chat-model': {
        type: 'llamacpp-completion',
        src: 'hyper://example.invalid/chat',
        preload: false
      }
    }
  }
} as const

const VI = '/qvac/v1/rag/vector_indexes'

describe('qvac rag: validation', () => {
  const server = useServer({ config: RAG_CONFIG })

  function post(url: string, payload: unknown) {
    return server().inject({ method: 'POST', url, payload: payload as object })
  }

  it('invalid JSON returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/rag/chunk',
      headers: JSON_HEADERS,
      payload: '{{bad'
    })
    assertStatusAndError(res, 400, 'invalid_json')
  })

  it('chunk rejects missing documents and bad options', async () => {
    assertStatusAndError(await post('/qvac/v1/rag/chunk', {}), 400, 'invalid_documents')
    assertStatusAndError(
      await post('/qvac/v1/rag/chunk', { documents: 'x', chunkOpts: { chunkSize: 0 } }),
      400,
      'invalid_chunk_opts'
    )
    assertStatusAndError(
      await post('/qvac/v1/rag/chunk', { documents: 'x', nope: 1 }),
      400,
      'invalid_request'
    )
  })

  it('rejects a workspace name that is not a safe component', async () => {
    for (const name of ['a.b', 'a%2Fb', 'x'.repeat(65)]) {
      const res = await post(`/qvac/v1/rag/workspaces/${name}/reindex`, {})
      assertStatusAndError(res, 400, 'invalid_workspace')
    }
  })

  it('ingest needs an embedding alias', async () => {
    const url = '/qvac/v1/rag/workspaces/docs/ingest'
    assertStatusAndError(await post(url, { documents: 'x' }), 400, 'missing_model')
    assertStatusAndError(await post(url, { model: 'nope', documents: 'x' }), 404, 'model_not_found')
    assertStatusAndError(
      await post(url, { model: 'chat-model', documents: 'x' }),
      400,
      'invalid_model_type'
    )
  })

  it('unknown workspaces return 404', async () => {
    const reindex = await post('/qvac/v1/rag/workspaces/rag-e2e-missing/reindex', {})
    assertStatusAndError(reindex, 404, 'workspace_not_found')
    const close = await post('/qvac/v1/rag/workspaces/rag-e2e-missing/close', {})
    assertStatusAndError(close, 404, 'workspace_not_found')
    const del = await server().inject({
      method: 'DELETE',
      url: '/qvac/v1/rag/workspaces/rag-e2e-missing'
    })
    assertStatusAndError(del, 404, 'workspace_not_found')
  })

  it('vector index create rejects bad dimensions and storage', async () => {
    assertStatusAndError(await post(VI, {}), 400, 'invalid_dim')
    assertStatusAndError(await post(VI, { dim: 12 }), 400, 'invalid_dim')
    assertStatusAndError(await post(VI, { dim: 8, storage: 'q3' }), 400, 'invalid_storage')
  })

  it('snapshot names cannot be paths', async () => {
    assertStatusAndError(
      await post(`${VI}/load`, { snapshot: '/etc/passwd' }),
      400,
      'invalid_snapshot'
    )
  })

  it('unknown vector index ids return 404', async () => {
    const get = await server().inject({ method: 'GET', url: `${VI}/vi_missing` })
    assertStatusAndError(get, 404, 'vector_index_not_found')
    const add = await post(`${VI}/vi_missing/add`, { ids: ['1'], vectors: [[1]] })
    assertStatusAndError(add, 404, 'vector_index_not_found')
    const del = await server().inject({ method: 'DELETE', url: `${VI}/vi_missing` })
    assertStatusAndError(del, 404, 'vector_index_not_found')
  })

  it('vector bodies are checked before the index is looked up', async () => {
    assertStatusAndError(
      await post(`${VI}/vi_x/add`, { ids: [], vectors: [[1]] }),
      400,
      'invalid_ids'
    )
    assertStatusAndError(
      await post(`${VI}/vi_x/search`, { queries: [[1]], k: 0 }),
      400,
      'invalid_k'
    )
    assertStatusAndError(
      await post(`${VI}/vi_x/search`, { queries: [], k: 1 }),
      400,
      'invalid_vectors'
    )
  })
})

describe('qvac rag: SDK calls that need no model', () => {
  const server = useServer({ config: RAG_CONFIG })

  function post(url: string, payload: unknown) {
    return server().inject({ method: 'POST', url, payload: payload as object })
  }

  it('chunks with the given options', async () => {
    const documents = ['First paragraph.\n\nSecond paragraph.\n\nThird paragraph.']
    const res = await post('/qvac/v1/rag/chunk', {
      documents,
      chunkOpts: {
        chunkSize: 4,
        chunkOverlap: 0,
        chunkStrategy: 'paragraph',
        splitStrategy: 'word'
      }
    })
    assert.equal(res.statusCode, 200, res.payload)
    const body = res.json() as { object: string; data: Array<{ id: string; content: string }> }
    assert.equal(body.object, 'list')
    assert.ok(body.data.length >= 2, `expected several chunks, got ${body.data.length}`)
    for (const chunk of body.data) {
      assert.equal(typeof chunk.id, 'string')
      assert.ok(chunk.content.length > 0)
    }
  })

  it('lists workspaces', async () => {
    const res = await server().inject({ method: 'GET', url: '/qvac/v1/rag/workspaces' })
    assert.equal(res.statusCode, 200, res.payload)
    const body = res.json() as { object: string; data: unknown[] }
    assert.equal(body.object, 'list')
    assert.ok(Array.isArray(body.data))
  })

  it('creates, fills, searches, snapshots, reloads and deletes a vector index', async () => {
    const created = await post(VI, { dim: 8, storage: 'f32' })
    assert.equal(created.statusCode, 200, created.payload)
    const index = created.json() as { id: string; dim: number; storage: string; length: number }
    assert.deepEqual(
      { dim: index.dim, storage: index.storage, length: index.length },
      {
        dim: 8,
        storage: 'f32',
        length: 0
      }
    )

    const unit = (i: number) => Array.from({ length: 8 }, (_, j) => (j === i ? 1 : 0))
    const added = await post(`${VI}/${index.id}/add`, {
      ids: ['1', 2, '18446744073709551614'],
      vectors: [unit(0), unit(1), unit(2)]
    })
    assert.equal(added.statusCode, 200, added.payload)
    assert.equal((added.json() as { length: number }).length, 3)

    assertStatusAndError(
      await post(`${VI}/${index.id}/add`, { ids: ['1'], vectors: [unit(3)] }),
      400,
      'invalid_ids'
    )
    assertStatusAndError(
      await post(`${VI}/${index.id}/add`, { ids: ['9', '9'], vectors: [unit(3), unit(4)] }),
      400,
      'invalid_ids'
    )
    assertStatusAndError(
      await post(`${VI}/${index.id}/add`, { ids: ['9'], vectors: [[1, 0]] }),
      400,
      'invalid_vectors'
    )
    assertStatusAndError(
      await post(`${VI}/${index.id}/add`, { ids: ['9', '10'], vectors: [unit(3)] }),
      400,
      'invalid_vectors'
    )

    const search = await post(`${VI}/${index.id}/search`, { queries: [unit(2), unit(0)], k: 1 })
    assert.equal(search.statusCode, 200, search.payload)
    const hits = (search.json() as { results: Array<Array<{ id: string }>> }).results
    assert.deepEqual(
      hits.map((row) => row.map((h) => h.id)),
      [['18446744073709551614'], ['1']]
    )

    const contains = await post(`${VI}/${index.id}/contains`, { ids: ['2', '3'] })
    assert.deepEqual((contains.json() as { present: boolean[] }).present, [true, false])

    // Fixed name: a rerun replaces the file instead of adding one.
    const snapshot = 'rag-e2e'
    const written = await post(`${VI}/${index.id}/write`, { snapshot })
    assert.equal(written.statusCode, 200, written.payload)

    const removed = await post(`${VI}/${index.id}/remove`, { ids: ['2', '3'] })
    assert.deepEqual(removed.json(), {
      id: index.id,
      object: 'vector_index',
      length: 2,
      removed: [true, false]
    })

    const loaded = await post(`${VI}/load`, { snapshot })
    assert.equal(loaded.statusCode, 200, loaded.payload)
    const reloaded = loaded.json() as { id: string; dim: number; length: number }
    assert.notEqual(reloaded.id, index.id)
    assert.equal(reloaded.dim, 8)
    assert.equal(reloaded.length, 3, 'the snapshot predates the remove')

    const list = await server().inject({ method: 'GET', url: VI })
    const ids = (list.json() as { data: Array<{ id: string }> }).data.map((d) => d.id)
    assert.ok(ids.includes(index.id) && ids.includes(reloaded.id))

    for (const id of [index.id, reloaded.id]) {
      const del = await server().inject({ method: 'DELETE', url: `${VI}/${id}` })
      assert.equal(del.statusCode, 200, del.payload)
      const gone = await server().inject({ method: 'GET', url: `${VI}/${id}` })
      assertStatusAndError(gone, 404, 'vector_index_not_found')
    }
  })

  it('a missing snapshot returns 404', async () => {
    const res = await post(`${VI}/load`, { snapshot: 'rag-e2e-never-written' })
    assertStatusAndError(res, 404, 'snapshot_not_found')
  })
})

interface OpenApiOperation {
  tags?: string[]
  responses?: Record<string, { description?: string }>
}

describe('qvac rag: surface', () => {
  const server = useServer()

  it('lists each route under RAG with its error codes', async () => {
    const res = await server().inject({ method: 'GET', url: '/openapi.json' })
    assert.equal(res.statusCode, 200)
    const doc = res.json() as { paths: Record<string, Record<string, OpenApiOperation>> }

    const expected: Array<[string, string, number, string]> = [
      ['/qvac/v1/rag/chunk', 'post', 400, 'invalid_chunk_opts'],
      ['/qvac/v1/rag/workspaces/{workspace}/ingest', 'post', 400, 'embedding_model_mismatch'],
      ['/qvac/v1/rag/workspaces/{workspace}/ingest', 'post', 500, 'rag_ingest_failed'],
      ['/qvac/v1/rag/workspaces/{workspace}/reindex', 'post', 404, 'workspace_not_found'],
      ['/qvac/v1/rag/workspaces/{workspace}', 'delete', 404, 'workspace_not_found'],
      ['/qvac/v1/rag/vector_indexes', 'post', 409, 'too_many_vector_indexes'],
      ['/qvac/v1/rag/vector_indexes/load', 'post', 404, 'snapshot_not_found'],
      ['/qvac/v1/rag/vector_indexes/{id}/add', 'post', 400, 'invalid_ids'],
      ['/qvac/v1/rag/vector_indexes/{id}/search', 'post', 404, 'vector_index_not_found']
    ]
    for (const [path, method, status, code] of expected) {
      const op = doc.paths[path]?.[method]
      assert.deepEqual(op?.tags, ['RAG'], `${method} ${path}`)
      assert.match(
        op?.responses?.[String(status)]?.description ?? '',
        new RegExp(`\`${code}\``),
        `${method} ${path} ${status}`
      )
    }
  })
})

describe('qvac rag: not mounted without the QVAC surface', () => {
  const server = useServer({ extensions: ['openai'] })

  it('returns 404', async () => {
    const res = await server().inject({ method: 'GET', url: '/qvac/v1/rag/workspaces' })
    assert.equal(res.statusCode, 404)
  })
})
