import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useModelServer } from '../helpers/server.js'
import { assertStatusAndError } from '../helpers/http.js'

const EMBED = 'rag-embed'
const OTHER_EMBED = 'rag-embed-other'
const WORKSPACE = `rag-e2e-${process.pid}`

const RAG_CONFIG = {
  serve: {
    models: {
      [EMBED]: { model: 'EMBEDDINGGEMMA_300M_Q4_0', preload: true, default: true },
      [OTHER_EMBED]: { model: 'EMBEDDINGGEMMA_300M_Q4_0', preload: false }
    }
  }
}

const DOCUMENTS = [
  'Titan, the largest moon of Saturn, has lakes of liquid methane.\n\nIts thick atmosphere is mostly nitrogen.',
  'Solar panels turn sunlight into electricity.\n\nInverters convert their output to alternating current.'
]

describe('qvac rag: real embedding model', () => {
  const server = useModelServer(RAG_CONFIG)
  const base = `/qvac/v1/rag/workspaces/${WORKSPACE}`

  function post(url: string, payload: unknown) {
    return server().inject({ method: 'POST', url, payload: payload as object })
  }

  it('ingests with chunking options, and refuses a second embedding alias', async () => {
    const res = await post(`${base}/ingest`, {
      model: EMBED,
      documents: DOCUMENTS,
      chunkOpts: { chunkStrategy: 'paragraph', chunkSize: 16, chunkOverlap: 0 }
    })
    assert.equal(res.statusCode, 200, res.payload)
    const body = res.json() as {
      object: string
      workspace: string
      model: string
      processed: Array<{ status: string; id?: string }>
    }
    assert.equal(body.object, 'rag.ingest')
    assert.equal(body.workspace, WORKSPACE)
    assert.equal(body.model, EMBED)
    assert.ok(
      body.processed.length >= 4,
      `expected one entry per paragraph, got ${body.processed.length}`
    )
    assert.ok(body.processed.every((p) => p.status === 'fulfilled'))

    const other = await post(`${base}/ingest`, { model: OTHER_EMBED, documents: 'More text.' })
    assertStatusAndError(other, 400, 'embedding_model_mismatch')
  })

  it('is searchable through /v1/vector_stores', async () => {
    const res = await post(`/v1/vector_stores/${WORKSPACE}/search`, {
      query: 'Which moon has methane lakes?',
      max_num_results: 1
    })
    assert.equal(res.statusCode, 200, res.payload)
    const hits = (res.json() as { data: Array<{ content: Array<{ text: string }> }> }).data
    assert.match(hits[0]?.content[0]?.text ?? '', /Titan|methane/)
  })

  it('reindexes, reporting why when there are too few chunks', async () => {
    const res = await post(`${base}/reindex`, {})
    assert.equal(res.statusCode, 200, res.payload)
    const body = res.json() as { object: string; workspace: string; reindexed: boolean }
    assert.equal(body.object, 'rag.reindex')
    assert.equal(body.workspace, WORKSPACE)
    assert.equal(typeof body.reindexed, 'boolean')
  })

  it('lists, closes and deletes the workspace', async () => {
    const listed = await server().inject({ method: 'GET', url: '/qvac/v1/rag/workspaces' })
    const names = (listed.json() as { data: Array<{ name: string }> }).data.map((w) => w.name)
    assert.ok(names.includes(WORKSPACE), `expected ${WORKSPACE} in ${names.join(', ')}`)

    const closed = await post(`${base}/close`, {})
    assert.equal(closed.statusCode, 200, closed.payload)
    assert.equal((closed.json() as { open: boolean }).open, false)

    const deleted = await server().inject({ method: 'DELETE', url: base })
    assert.equal(deleted.statusCode, 200, deleted.payload)
    assertStatusAndError(await post(`${base}/reindex`, {}), 404, 'workspace_not_found')
  })

  it('forgets the embedding alias of a workspace deleted through /v1/vector_stores', async () => {
    const stale = `${WORKSPACE}-stale`
    const first = await post(`/qvac/v1/rag/workspaces/${stale}/ingest`, {
      model: EMBED,
      documents: 'Some text.'
    })
    assert.equal(first.statusCode, 200, first.payload)

    const deleted = await server().inject({ method: 'DELETE', url: `/v1/vector_stores/${stale}` })
    assert.equal(deleted.statusCode, 200, deleted.payload)

    try {
      const again = await post(`/qvac/v1/rag/workspaces/${stale}/ingest`, {
        model: OTHER_EMBED,
        documents: 'Other text.'
      })
      assert.equal(again.statusCode, 200, again.payload)
      assert.equal((again.json() as { model: string }).model, OTHER_EMBED)
    } finally {
      await server().inject({ method: 'DELETE', url: `/qvac/v1/rag/workspaces/${stale}` })
    }
  })

  it('finds the document an embedded query is about', async () => {
    const embedded = await post('/v1/embeddings', { model: EMBED, input: DOCUMENTS })
    assert.equal(embedded.statusCode, 200, embedded.payload)
    const vectors = (embedded.json() as { data: Array<{ embedding: number[] }> }).data.map(
      (d) => d.embedding
    )

    const created = await post('/qvac/v1/rag/vector_indexes', { dim: vectors[0]!.length })
    assert.equal(created.statusCode, 200, created.payload)
    const id = (created.json() as { id: string }).id

    try {
      const added = await post(`/qvac/v1/rag/vector_indexes/${id}/add`, { ids: [1, 2], vectors })
      assert.equal(added.statusCode, 200, added.payload)

      const query = await post('/v1/embeddings', {
        model: EMBED,
        input: 'How does solar power work?'
      })
      const queryVector = (query.json() as { data: Array<{ embedding: number[] }> }).data[0]!
        .embedding
      const search = await post(`/qvac/v1/rag/vector_indexes/${id}/search`, {
        queries: [queryVector],
        k: 1
      })
      assert.equal(search.statusCode, 200, search.payload)
      const results = (search.json() as { results: Array<Array<{ id: string }>> }).results
      assert.equal(results[0]?.[0]?.id, '2')
    } finally {
      await server().inject({ method: 'DELETE', url: `/qvac/v1/rag/vector_indexes/${id}` })
    }
  })
})
