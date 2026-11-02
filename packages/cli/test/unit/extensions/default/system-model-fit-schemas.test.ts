import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifySchemaValidationError } from 'fastify/types/schema.js'
import { validatorCompiler } from 'fastify-type-provider-zod'
import {
  MAX_FIT_MODELS,
  MODEL_FIT_FIELD_CODES,
  modelFitBody,
  modelFitResult
} from '@/serve/extensions/default/schemas/model-fit'
import { systemQuery, systemResult } from '@/serve/extensions/default/schemas/system'
import { mergeConfig } from '@/serve/extensions/default/routes/model-fit'
import { errorResponses } from '@/serve/lib/error-responses'

function issuePaths(input: unknown): string[] {
  const result = modelFitBody.safeParse(input)
  assert.equal(result.success, false, `expected ${JSON.stringify(input)} to fail validation`)
  return result.error!.issues.map((i) => i.path.join('/'))
}

describe('modelFitBody', () => {
  it('accepts named models with optional config, execution and policy', () => {
    const result = modelFitBody.safeParse({
      models: [
        { model: 'my-llm', modelConfig: { ctx_size: 8192 } },
        { model: 'QWEN3_600M_INST_Q4' }
      ],
      execution: 'concurrent',
      policy: 'interactive-v1'
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

  it('rejects an unknown execution or policy', () => {
    assert.deepEqual(issuePaths({ models: [{ model: 'm' }], execution: 'parallel' }), ['execution'])
    assert.deepEqual(issuePaths({ models: [{ model: 'm' }], policy: 'batch-v1' }), ['policy'])
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
  it('passes through fields the SDK adds later', () => {
    const parsed = modelFitResult.parse({
      object: 'model_fit',
      verdict: 'unknown',
      basis: 'system-memory',
      execution: 'sequential',
      models: [{ model: 'a', name: 'A', verdict: 'unknown', reasons: [], newField: 1 }],
      reasons: [],
      assumptions: [],
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
