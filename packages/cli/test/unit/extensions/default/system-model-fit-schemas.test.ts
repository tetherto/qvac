import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifySchemaValidationError } from 'fastify/types/schema.js'
import { validatorCompiler } from 'fastify-type-provider-zod'
import { SDK_CLIENT_ERROR_CODES, SDK_SERVER_ERROR_CODES } from '@qvac/sdk'
import {
  MAX_FIT_MODELS,
  MODEL_FIT_FIELD_CODES,
  modelFitBody,
  modelFitResult
} from '@/serve/extensions/default/schemas/model-fit'
import { systemQuery, systemResult } from '@/serve/extensions/default/schemas/system'
import { mergeConfig, toHttpError } from '@/serve/extensions/default/routes/model-fit'
import { errorResponses } from '@/serve/lib/error-responses'

function issuePaths(input: unknown): string[] {
  const result = modelFitBody.safeParse(input)
  assert.equal(result.success, false, `expected ${JSON.stringify(input)} to fail validation`)
  return result.error!.issues.map((i) => i.path.join('/'))
}

describe('modelFitBody', () => {
  it('accepts named models with optional config', () => {
    const result = modelFitBody.safeParse({
      models: [
        { model: 'my-llm', modelConfig: { ctx_size: 8192 } },
        { model: 'QWEN3_600M_INST_Q4' }
      ]
    })
    assert.equal(result.success, true)
  })

  it('requires a non-empty models list of named entries', () => {
    assert.deepEqual(issuePaths({}), ['models'])
    assert.deepEqual(issuePaths({ models: [] }), ['models'])
    assert.deepEqual(issuePaths({ models: [{}] }), ['models/0/model'])
    assert.deepEqual(issuePaths({ models: [{ model: '' }] }), ['models/0/model'])
  })

  it('caps the list', () => {
    const atCap = Array.from({ length: MAX_FIT_MODELS }, () => ({ model: 'm' }))
    assert.equal(modelFitBody.safeParse({ models: atCap }).success, true)
    assert.deepEqual(issuePaths({ models: [...atCap, { model: 'm' }] }), ['models'])
  })

  it('rejects a raw source on an entry and unknown top-level fields', () => {
    assert.deepEqual(issuePaths({ models: [{ model: 'm', modelSrc: '/etc/passwd' }] }), [
      'models/0'
    ])
    assert.deepEqual(issuePaths({ models: [{ model: 'm' }], nope: true }), [''])
  })

  // The error handler builds its `models:too_big` lookup key from these two fields.
  it('surfaces the over-cap issue on err.validation as keyword and instancePath', () => {
    const validate = validatorCompiler({
      schema: modelFitBody,
      method: 'POST',
      url: '/qvac/v1/models/fit',
      httpPart: 'body'
    })
    const result = validate({
      models: Array.from({ length: MAX_FIT_MODELS + 1 }, () => ({ model: 'm' }))
    }) as { error?: FastifySchemaValidationError[] }

    assert.equal(result.error?.[0]?.keyword, 'too_big')
    assert.equal(result.error?.[0]?.instancePath, '/models')
    assert.equal(MODEL_FIT_FIELD_CODES['models:too_big'], 'too_many_models')
  })
})

describe('modelFitResult', () => {
  it('carries the pools and each model with its device rows', () => {
    const result = modelFitResult.safeParse({
      object: 'model_fit',
      verdict: 'fits',
      pools: [{ id: 'host', unified: true, usedBytes: 1024, freeBytes: 4096, totalBytes: 8192 }],
      models: [
        {
          model: 'a',
          status: 'fits',
          devices: [{ id: 'CPU', name: 'CPU', unified: true, usedBytes: 1024, freeBytes: 4096 }],
          stats: {}
        }
      ]
    })
    assert.equal(result.success, true, JSON.stringify(result.error?.issues))
  })

  it('takes llama.cpp stats or empty stats, nothing else', () => {
    const withStats = (stats: unknown) =>
      modelFitResult.safeParse({
        object: 'model_fit',
        verdict: 'fits',
        pools: [],
        models: [{ model: 'a', status: 'fits', devices: [], stats }]
      }).success

    assert.equal(withStats({ ctxSize: 8192, gpuLayers: 37 }), true)
    assert.equal(withStats({}), true)
    assert.equal(withStats({ ctxSize: 8192 }), false)
    assert.equal(withStats({ other: 1 }), false)
  })

  it('passes through fields the SDK adds later', () => {
    const parsed = modelFitResult.parse({
      object: 'model_fit',
      verdict: 'unknown',
      pools: [],
      models: [{ model: 'a', status: 'unknown', devices: [], stats: {}, newField: 1 }],
      later: true
    })
    assert.equal((parsed as Record<string, unknown>)['later'], true)
    assert.equal((parsed.models[0] as Record<string, unknown>)['newField'], 1)
  })
})

describe('systemQuery', () => {
  it('reads sample as a boolean, defaulting to false', () => {
    assert.equal(systemQuery.parse({}).sample, false)
    assert.equal(systemQuery.parse({ sample: 'true' }).sample, true)
    assert.equal(systemQuery.parse({ sample: 'false' }).sample, false)
    assert.equal(systemQuery.safeParse({ sample: 'yes' }).success, false)
  })
})

describe('systemResult', () => {
  const supported = (value: unknown) => ({
    status: 'supported',
    value,
    provenance: { source: 'os' }
  })

  it('accepts supported and unavailable metrics', () => {
    const result = systemResult.safeParse({
      object: 'system',
      capabilities: {
        cpu: { status: 'unavailable', reason: 'not exposed' },
        memory: { totalBytes: supported(1024) },
        gpus: supported([])
      }
    })
    assert.equal(result.success, true, JSON.stringify(result.error?.issues))
  })

  it('rejects a supported metric without a value', () => {
    const result = systemResult.safeParse({
      object: 'system',
      capabilities: {
        cpu: { status: 'unavailable' },
        memory: { totalBytes: { status: 'supported', provenance: { source: 'os' } } },
        gpus: { status: 'failed' }
      }
    })
    assert.equal(result.success, false)
  })
})

describe('errorResponses', () => {
  it('describes each status by the codes it carries', () => {
    const responses = errorResponses({
      400: { invalid_models: 'bad models', too_many_models: 'too many' },
      500: { model_fit_failed: 'sdk failed' }
    })
    assert.deepEqual(Object.keys(responses), ['400', '500'])
    assert.equal(
      responses[400]!.description,
      '- `invalid_models`: bad models\n- `too_many_models`: too many'
    )
    assert.equal(responses[500]!.description, '- `model_fit_failed`: sdk failed')
  })
})

describe('toHttpError', () => {
  const sdkError = (code: number, message: string) => Object.assign(new Error(message), { code })

  it('makes a config the engine schema refuses a 400 with its message', () => {
    const err = toHttpError(
      sdkError(SDK_SERVER_ERROR_CODES.PLUGIN_LOAD_CONFIG_VALIDATION_FAILED, 'ctx_size: too small')
    )
    assert.equal(err.status, 400)
    assert.equal(err.code, 'invalid_model_config')
    assert.equal(err.message, 'ctx_size: too small')
  })

  it('makes a config value the engine refuses while applying its defaults a 400', () => {
    const err = toHttpError(
      sdkError(SDK_CLIENT_ERROR_CODES.REQUEST_VALIDATION_FAILED, 'ctx_size: expected number')
    )
    assert.equal(err.status, 400)
    assert.equal(err.code, 'invalid_model_config')
    assert.equal(err.message, 'ctx_size: expected number')
  })

  it('keeps every other failure a 500', () => {
    for (const err of [
      toHttpError(sdkError(SDK_SERVER_ERROR_CODES.COMPLETION_FAILED, 'boom')),
      toHttpError(new Error('boom')),
      toHttpError('boom')
    ]) {
      assert.equal(err.status, 500)
      assert.equal(err.code, 'model_fit_failed')
    }
  })
})

describe('mergeConfig', () => {
  it('keeps sibling keys of a nested object the request only partly overrides', () => {
    const merged = mergeConfig(
      { language: 'en', contextParams: { use_gpu: true, n_ctx: 448 } },
      { contextParams: { n_ctx: 1024 } }
    )
    assert.deepEqual(merged, { language: 'en', contextParams: { use_gpu: true, n_ctx: 1024 } })
  })

  it('replaces arrays, scalars and model sources whole', () => {
    const base = {
      stop: ['a', 'b'],
      ctx_size: 2048,
      projectionModelSrc: { src: 'registry://old', name: 'OLD', addon: 'llm' }
    }
    const next = { src: 'registry://new', name: 'NEW', addon: 'llm' }
    const merged = mergeConfig(base, { stop: ['c'], ctx_size: 4096, projectionModelSrc: next })
    assert.deepEqual(merged, { stop: ['c'], ctx_size: 4096, projectionModelSrc: next })
  })

  it('leaves the alias config untouched', () => {
    const base = { contextParams: { use_gpu: true } }
    mergeConfig(base, { contextParams: { use_gpu: false } })
    assert.deepEqual(base, { contextParams: { use_gpu: true } })
  })
})
