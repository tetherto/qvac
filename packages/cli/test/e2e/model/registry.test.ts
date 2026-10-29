import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useModelServer } from '../helpers/server.js'
import { assertStatusAndError } from '../helpers/http.js'

interface RegistryModel {
  name: string
  registryPath: string
  registrySource: string
  addon: string
  engine: string
  expectedSize: number
}

interface RegistryList {
  object: string
  data: RegistryModel[]
  has_more: boolean
}

// Queries the live registry over P2P; nothing is loaded.
describe('qvac registry: live registry', () => {
  const server = useModelServer({ serve: { models: {} } })

  async function get(url: string) {
    const res = await server().inject({ method: 'GET', url })
    assert.equal(res.statusCode, 200, res.payload)
    return res
  }

  it('lists entries and pages them', async () => {
    const all = (await get('/qvac/v1/registry/models')).json() as RegistryList
    assert.equal(all.object, 'list')
    assert.ok(all.data.length > 1)
    assert.equal(all.has_more, false)

    const page = (await get('/qvac/v1/registry/models?limit=1&offset=1')).json() as RegistryList
    assert.deepEqual(page.data, [all.data[1]])
    assert.equal(page.has_more, all.data.length > 2)
  })

  it('filters by addon and search', async () => {
    const body = (
      await get('/qvac/v1/registry/models?addon=llm&search=qwen3')
    ).json() as RegistryList
    assert.ok(body.data.length > 0)
    for (const model of body.data) {
      assert.equal(model.addon, 'llm')
      assert.match(`${model.name} ${model.registryPath} ${model.engine}`.toLowerCase(), /qwen3/)
    }
  })

  it('looks up a listed entry, and 404s an unknown one', async () => {
    const [first] = ((await get('/qvac/v1/registry/models?limit=1')).json() as RegistryList).data
    const query = new URLSearchParams({
      registrySource: first!.registrySource,
      registryPath: first!.registryPath
    })
    const found = (await get(`/qvac/v1/registry/models/lookup?${query}`)).json() as RegistryModel
    assert.deepEqual(found, first)

    const missing = await server().inject({
      method: 'GET',
      url: `/qvac/v1/registry/models/lookup?registrySource=hf&registryPath=nope/missing.gguf`
    })
    assertStatusAndError(missing, 404, 'model_not_found')
  })
})
