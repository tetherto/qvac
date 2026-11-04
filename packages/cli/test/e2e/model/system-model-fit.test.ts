import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useModelServer } from '../helpers/server.js'

const ALIAS = 'fit-llm'
const VERDICTS = ['likely-fits', 'likely-too-large', 'unknown']

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
  execution: string
  budget?: { availableAfterReserveBytes: number }
  models: Array<{ model: string; name: string; verdict: string; reasons: string[] }>
  reasons: string[]
  assumptions: string[]
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
    assert.equal(body.execution, 'sequential')
    assert.ok(body.budget, 'expected a memory budget on a desktop host')
    assert.equal(body.models.length, 1)
    assert.equal(body.models[0]!.model, ALIAS)
    assert.equal(body.models[0]!.name, 'QWEN3_600M_INST_Q4')
    assert.ok(Array.isArray(body.assumptions))

    const entry = server().qvac.registry.getEntry(ALIAS)
    assert.notEqual(entry?.state, server().qvac.registry.STATES.READY, 'fit must not load')
  })

  it('assesses an alias and a constant together, in request order', async () => {
    const res = await fit({
      models: [
        { model: ALIAS, modelConfig: { ctx_size: 4096 } },
        { model: 'EMBEDDINGGEMMA_300M_Q4_0' }
      ],
      execution: 'concurrent'
    })
    assert.equal(res.statusCode, 200, res.payload)

    const body = res.json() as FitResult
    assert.equal(body.execution, 'concurrent')
    assert.deepEqual(
      body.models.map((m) => m.model),
      [ALIAS, 'EMBEDDINGGEMMA_300M_Q4_0']
    )
    for (const model of body.models) {
      assert.ok(VERDICTS.includes(model.verdict), `unexpected verdict ${model.verdict}`)
    }
  })
})
