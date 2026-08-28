import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import { useServer } from '../helpers/server.js'

interface CatalogEntry {
  object: string
  id: string
  source: string
  configured: boolean
  usable: boolean
  state: string
  role: string
  addon: string | null
  size: number | null
  hint?: string
}
interface CatalogList {
  object: string
  data: CatalogEntry[]
  has_more: boolean
}

describe('serve: model catalog', () => {
  // Default MODELLESS_CONFIG declares one configured (preload:false) model: fake-transcribe.
  const server = useServer()
  const get = (url: string) => (server() as FastifyInstance).inject({ method: 'GET', url })

  it('lists catalog entries as model_catalog_entry objects', async () => {
    const res = await get('/v1/models/catalog')
    assert.equal(res.statusCode, 200)
    const body = res.json() as CatalogList
    assert.equal(body.object, 'list')
    assert.ok(body.data.length > 1, 'built-in constants should populate the catalog')
    assert.equal(body.has_more, false, 'no default limit — the full catalog is returned')
    assert.ok(body.data.every((e) => e.object === 'model_catalog_entry'))
  })

  it('marks a known SDK constant not_configured / not usable', async () => {
    const res = await get('/v1/models/catalog/QWEN3_600M_INST_Q4')
    assert.equal(res.statusCode, 200)
    const e = res.json() as CatalogEntry
    assert.equal(e.source, 'builtin')
    assert.equal(e.configured, false)
    assert.equal(e.usable, false)
    assert.equal(e.state, 'not_configured')
    assert.ok((e.size ?? 0) > 0)
    assert.ok(e.hint)
  })

  it('marks a configured model configured/usable with its load state', async () => {
    const e = (await get('/v1/models/catalog/fake-transcribe')).json() as CatalogEntry
    assert.equal(e.source, 'config')
    assert.equal(e.configured, true)
    assert.equal(e.usable, true)
    assert.equal(e.state, 'idle')
    assert.equal(e.role, 'transcription')
  })

  it('filters by role and addon', async () => {
    const chat = (await get('/v1/models/catalog?role=chat')).json() as CatalogList
    assert.ok(chat.data.length > 0)
    assert.ok(chat.data.every((e) => e.role === 'chat'))
    const llm = (await get('/v1/models/catalog?addon=llm')).json() as CatalogList
    assert.ok(llm.data.every((e) => e.addon === 'llm'))
  })

  it('searches by id substring', async () => {
    const body = (await get('/v1/models/catalog?search=QWEN')).json() as CatalogList
    assert.ok(body.data.length > 0)
    assert.ok(body.data.every((e) => e.id.toLowerCase().includes('qwen')))
  })

  it('paginates with has_more', async () => {
    const body = (await get('/v1/models/catalog?limit=5')).json() as CatalogList
    assert.equal(body.data.length, 5)
    assert.equal(body.has_more, true)
  })

  it('returns 404 for an unknown catalog id', async () => {
    const res = await get('/v1/models/catalog/definitely-not-a-model')
    assert.equal(res.statusCode, 404)
    assert.equal((res.json() as { error: { code: string } }).error.code, 'model_not_found')
  })
})
