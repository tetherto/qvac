import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useModelServer } from '../helpers/server.js'

const ALIAS = 'runtime-llm'

const CONFIG = {
  serve: {
    models: {
      [ALIAS]: { model: 'QWEN3_600M_INST_Q4', preload: true, config: { ctx_size: 2048 } },
      idle: { model: 'QWEN3_600M_INST_Q4', preload: false }
    }
  }
}

interface RuntimeModel {
  object: string
  model: string
  modelId: string
  modelType: string
  handlers: string[]
  loadedAt: number
  path?: string
}

describe('qvac runtime: loaded models', () => {
  const server = useModelServer(CONFIG, { enableAdmin: true })

  it('lists the preloaded alias with its SDK info, and not the idle one', async () => {
    const res = await server().inject({ method: 'GET', url: '/qvac/v1/runtime/models' })
    assert.equal(res.statusCode, 200, res.payload)
    const { data } = res.json() as { data: RuntimeModel[] }
    assert.deepEqual(
      data.map((m) => m.model),
      [ALIAS]
    )
    const [row] = data
    assert.equal(row!.object, 'runtime.model')
    assert.equal(row!.modelId, server().qvac.registry.getEntry(ALIAS)!.sdkModelId)
    assert.ok(row!.handlers.includes('completionStream'), row!.handlers.join(','))
    assert.ok(row!.loadedAt > 0)
    assert.equal(row!.path, undefined)
  })

  it('reads the active state from the SDK', async () => {
    const res = await server().inject({ method: 'GET', url: '/qvac/v1/runtime/state' })
    assert.equal(res.statusCode, 200, res.payload)
    assert.deepEqual(res.json(), { object: 'runtime.state', state: 'active' })
  })

  it('refuses chat while suspended and serves it again after resume', async () => {
    const app = server()
    const chat = () =>
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: ALIAS, messages: [{ role: 'user', content: 'Say hi.' }], max_tokens: 4 }
      })

    const suspended = await app.inject({ method: 'POST', url: '/qvac/v1/runtime/suspend' })
    assert.deepEqual(suspended.json(), { object: 'runtime.state', state: 'suspended' })
    try {
      const blocked = await chat()
      assert.equal(blocked.statusCode, 503)
      assert.equal((blocked.json() as { error: { code: string } }).error.code, 'runtime_suspended')
      const state = await app.inject({ method: 'GET', url: '/qvac/v1/runtime/state' })
      assert.equal((state.json() as { state: string }).state, 'suspended')
    } finally {
      const resumed = await app.inject({ method: 'POST', url: '/qvac/v1/runtime/resume' })
      assert.deepEqual(resumed.json(), { object: 'runtime.state', state: 'active' })
    }
    assert.equal((await chat()).statusCode, 200)
  })
})
