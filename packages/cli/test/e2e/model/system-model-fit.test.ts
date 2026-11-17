import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useModelServer } from '../helpers/server.js'
import { assertStatusAndError } from '../helpers/http.js'

const ALIAS = 'fit-llm'
const VERDICTS = ['fits', 'does-not-fit', 'unknown']

// preload:false: the point of the endpoint is asking before anything loads.
const FIT_CONFIG = {
  serve: {
    models: {
      [ALIAS]: { model: 'QWEN3_600M_INST_Q4', preload: false, config: { ctx_size: 2048 } }
    }
  }
}

interface Metric {
  status: string
  value?: unknown
}

interface SystemResult {
  object: string
  capabilities: { memory: { totalBytes: Metric } }
  sample?: { sampledAt: number; memory: { usedBytes: Metric } }
}

interface FitResult {
  object: string
  verdict: string
  pools: Array<{ id: string; unified: boolean; usedBytes: number }>
  models: Array<{
    model: string
    status: string
    devices: Array<{ id: string; name: string; unified: boolean; usedBytes: number }>
    stats: Record<string, unknown>
  }>
}

describe('qvac system and models/fit: real host', () => {
  const server = useModelServer(FIT_CONFIG)

  function fit(payload: unknown) {
    return server().inject({
      method: 'POST',
      url: '/qvac/v1/models/fit',
      payload: payload as object
    })
  }

  it('reports total memory, without a sample by default', async () => {
    const res = await server().inject({ method: 'GET', url: '/qvac/v1/system' })
    assert.equal(res.statusCode, 200, res.payload)

    const body = res.json() as SystemResult
    assert.equal(body.object, 'system')
    const total = body.capabilities.memory.totalBytes
    assert.equal(total.status, 'supported')
    assert.ok(typeof total.value === 'number' && total.value > 0)
    assert.equal(body.sample, undefined)
  })

  it('adds a sample when asked', async () => {
    const res = await server().inject({ method: 'GET', url: '/qvac/v1/system?sample=true' })
    assert.equal(res.statusCode, 200, res.payload)

    const sample = (res.json() as SystemResult).sample
    assert.ok(sample, 'expected a sample')
    assert.ok(sample.sampledAt > 0)
    assert.equal(sample.memory.usedBytes.status, 'supported')
  })

  it('assesses a configured alias without loading it', async () => {
    const res = await fit({ models: [{ model: ALIAS }] })
    assert.equal(res.statusCode, 200, res.payload)

    const body = res.json() as FitResult
    assert.equal(body.object, 'model_fit')
    assert.ok(VERDICTS.includes(body.verdict), `unexpected verdict ${body.verdict}`)
    assert.equal(body.models.length, 1)
    assert.equal(body.models[0]!.model, ALIAS)
    assert.ok(VERDICTS.includes(body.models[0]!.status))
    assert.ok(Array.isArray(body.pools))
    assert.ok(Array.isArray(body.models[0]!.devices))
    assert.equal(typeof body.models[0]!.stats, 'object')

    const entry = server().qvac.registry.getEntry(ALIAS)
    assert.notEqual(entry?.state, server().qvac.registry.STATES.READY, 'fit must not load')
  })

  it('answers a config value the engine refuses with a 400', async () => {
    const res = await fit({ models: [{ model: ALIAS, modelConfig: { ctx_size: 'bad' } }] })
    assertStatusAndError(res, 400, 'invalid_model_config')
  })

  it('assesses an alias and a constant together, in request order', async () => {
    const res = await fit({
      models: [
        { model: ALIAS, modelConfig: { ctx_size: 4096 } },
        { model: 'EMBEDDINGGEMMA_300M_Q4_0' }
      ]
    })
    assert.equal(res.statusCode, 200, res.payload)

    const body = res.json() as FitResult
    assert.ok(VERDICTS.includes(body.verdict), `unexpected verdict ${body.verdict}`)
    assert.deepEqual(
      body.models.map((m) => m.model),
      [ALIAS, 'EMBEDDINGGEMMA_300M_Q4_0']
    )
    for (const model of body.models) {
      assert.ok(VERDICTS.includes(model.status), `unexpected status ${model.status}`)
    }
  })
})
