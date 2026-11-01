import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from '../helpers/server.js'
import { JSON_HEADERS, assertStatusAndError } from '../helpers/http.js'

const FIT_CONFIG = {
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

describe('qvac models/fit: validation', () => {
  const server = useServer({ config: FIT_CONFIG })

  function fit(payload: unknown) {
    return server().inject({
      method: 'POST',
      url: '/qvac/v1/models/fit',
      payload: payload as object
    })
  }

  it('invalid JSON returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/models/fit',
      headers: JSON_HEADERS,
      payload: '{{bad'
    })
    assertStatusAndError(res, 400, 'invalid_json')
  })

  it('missing or empty models returns 400', async () => {
    assertStatusAndError(await fit({}), 400, 'invalid_models')
    assertStatusAndError(await fit({ models: [] }), 400, 'invalid_models')
  })

  it('an entry without a model returns 400', async () => {
    assertStatusAndError(await fit({ models: [{}] }), 400, 'invalid_models')
  })

  it('rejects a list over the cap with its own code', async () => {
    const models = Array.from({ length: 17 }, () => ({ model: 'chat-model' }))
    assertStatusAndError(await fit({ models }), 400, 'too_many_models')
  })

  it('rejects an unknown execution and policy', async () => {
    const models = [{ model: 'chat-model' }]
    assertStatusAndError(await fit({ models, execution: 'parallel' }), 400, 'invalid_execution')
    assertStatusAndError(await fit({ models, policy: 'batch-v1' }), 400, 'invalid_policy')
  })

  it('rejects an unknown field, including a raw model source', async () => {
    assertStatusAndError(
      await fit({ models: [{ model: 'chat-model' }], nope: true }),
      400,
      'invalid_request'
    )
    assertStatusAndError(
      await fit({ models: [{ model: 'chat-model', modelSrc: '/etc/passwd' }] }),
      400,
      'invalid_models'
    )
  })

  it('rejects a companion source that is not a model constant', async () => {
    for (const source of ['/models/proj.gguf', 'https://example.com/m.gguf', { src: '/x' }]) {
      const res = await fit({
        models: [{ model: 'chat-model', modelConfig: { projectionModelSrc: source } }]
      })
      assertStatusAndError(res, 400, 'invalid_model_src')
    }
  })

  it('looks for companion sources in nested config too', async () => {
    const res = await fit({
      models: [{ model: 'chat-model', modelConfig: { upscaler: { model_src: './esrgan.bin' } } }]
    })
    assertStatusAndError(res, 400, 'invalid_model_src')
  })

  it('an unknown model returns 404', async () => {
    assertStatusAndError(await fit({ models: [{ model: 'nope' }] }), 404, 'model_not_found')
  })
})

describe('qvac system: validation', () => {
  const server = useServer()

  it('rejects a sample flag that is not a boolean', async () => {
    const res = await server().inject({ method: 'GET', url: '/qvac/v1/system?sample=yes' })
    assertStatusAndError(res, 400, 'invalid_sample')
  })
})

interface OpenApiOperation {
  tags?: string[]
  responses?: Record<string, { description?: string }>
}

describe('qvac system and models/fit: surface', () => {
  const server = useServer()

  async function operation(path: string, method: string): Promise<OpenApiOperation | undefined> {
    const res = await server().inject({ method: 'GET', url: '/openapi.json' })
    assert.equal(res.statusCode, 200)
    const doc = res.json() as { paths: Record<string, Record<string, OpenApiOperation>> }
    return doc.paths[path]?.[method]
  }

  it('lists each error code under its status', async () => {
    const fit = await operation('/qvac/v1/models/fit', 'post')
    assert.deepEqual(fit?.tags, ['System'])
    for (const code of ['invalid_models', 'too_many_models', 'invalid_model_src']) {
      assert.match(fit?.responses?.['400']?.description ?? '', new RegExp(`\`${code}\``))
    }
    assert.match(fit?.responses?.['404']?.description ?? '', /`model_not_found`/)
    assert.match(fit?.responses?.['500']?.description ?? '', /`model_fit_failed`/)

    const system = await operation('/qvac/v1/system', 'get')
    assert.deepEqual(system?.tags, ['System'])
    assert.match(system?.responses?.['400']?.description ?? '', /`invalid_sample`/)
    assert.match(system?.responses?.['500']?.description ?? '', /`system_resources_failed`/)
  })
})

describe('qvac system and models/fit: not mounted without the QVAC surface', () => {
  const server = useServer({ extensions: ['openai'] })

  it('returns 404', async () => {
    const system = await server().inject({ method: 'GET', url: '/qvac/v1/system' })
    assert.equal(system.statusCode, 404)

    const fit = await server().inject({
      method: 'POST',
      url: '/qvac/v1/models/fit',
      payload: { models: [{ model: 'x' }] }
    })
    assert.equal(fit.statusCode, 404)
  })
})
