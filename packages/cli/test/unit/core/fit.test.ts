import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MMPROJ_QWEN3_8_27B_MULTIMODAL_F16, QWEN3_600M_INST_Q4 } from '@qvac/sdk'
import { parseServeConfig } from '@/serve/core/config'
import { FitInputError, fitModelType, resolveFitCandidate } from '@/serve/core/fit'

const serveConfig = parseServeConfig(
  {
    serve: {
      models: {
        'my-llm': { model: 'QWEN3_600M_INST_Q4', config: { ctx_size: 2048, temp: 0.2 } }
      }
    }
  },
  {}
)

function inputError(run: () => unknown): FitInputError {
  try {
    run()
  } catch (err) {
    assert.ok(err instanceof FitInputError)
    return err
  }
  assert.fail('expected a FitInputError')
}

describe('fitModelType', () => {
  it('names the model type of an alias or a constant, and nothing for an unknown name', () => {
    assert.equal(fitModelType(serveConfig, 'my-llm'), 'llamacpp-completion')
    assert.equal(fitModelType(serveConfig, 'QWEN3_600M_INST_Q4'), 'llamacpp-completion')
    assert.equal(fitModelType(serveConfig, 'nope'), undefined)
  })
})

describe('resolveFitCandidate', () => {
  it('assesses an alias with its own config, the candidate config merged over it', () => {
    const request = resolveFitCandidate(serveConfig, {
      model: 'my-llm',
      modelConfig: { ctx_size: 8192 }
    })
    assert.equal(request.modelSrc, QWEN3_600M_INST_Q4)
    assert.equal(request.modelType, 'llamacpp-completion')
    assert.deepEqual(request.modelConfig, { ctx_size: 8192, temp: 0.2 })
  })

  it('assesses a constant with the candidate config on the engine defaults', () => {
    const request = resolveFitCandidate(serveConfig, {
      model: 'QWEN3_600M_INST_Q4',
      modelConfig: { ctx_size: 0 }
    })
    assert.equal(request.modelSrc, QWEN3_600M_INST_Q4)
    assert.equal(request.modelType, 'llamacpp-completion')
    assert.deepEqual(request.modelConfig, { ctx_size: 0 })
  })

  it('turns a companion constant name into the constant', () => {
    const request = resolveFitCandidate(serveConfig, {
      model: 'QWEN3_600M_INST_Q4',
      modelConfig: { projectionModelSrc: 'MMPROJ_QWEN3_8_27B_MULTIMODAL_F16' }
    })
    assert.deepEqual(request.modelConfig, {
      projectionModelSrc: MMPROJ_QWEN3_8_27B_MULTIMODAL_F16
    })
  })

  it('refuses a name that is neither an alias nor a constant', () => {
    assert.equal(
      inputError(() => resolveFitCandidate(serveConfig, { model: 'nope' })).code,
      'model_not_found'
    )
  })

  it('refuses a companion source that is a path, however deep', () => {
    const err = inputError(() =>
      resolveFitCandidate(serveConfig, {
        model: 'QWEN3_600M_INST_Q4',
        modelConfig: { pivotModel: { srcVocabSrc: '/etc/passwd' } }
      })
    )
    assert.equal(err.code, 'invalid_model_src')
    assert.match(err.message, /modelConfig\.pivotModel\.srcVocabSrc/)
  })
})
