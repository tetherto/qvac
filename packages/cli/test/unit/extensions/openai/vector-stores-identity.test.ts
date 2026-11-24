import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { vectorConfigJson } from '@/serve/extensions/openai/routes/vector-stores'

describe('vectorConfigJson', () => {
  it('ignores load options that do not change the vectors', () => {
    const base = vectorConfigJson({ pooling: 'mean' })
    assert.equal(
      vectorConfigJson({
        pooling: 'mean',
        device: 'cpu',
        gpuLayers: 0,
        batchSize: 256,
        verbosity: 3,
        flashAttention: 'off'
      }),
      base
    )
  })

  it('changes when pooling, attention or normalization change', () => {
    const base = vectorConfigJson({ pooling: 'mean' })
    assert.notEqual(vectorConfigJson({ pooling: 'cls' }), base)
    assert.notEqual(vectorConfigJson({ pooling: 'mean', attention: 'causal' }), base)
    assert.notEqual(vectorConfigJson({ pooling: 'mean', embdNormalize: 0 }), base)
  })

  it('does not depend on key order', () => {
    assert.equal(
      vectorConfigJson({ embdNormalize: 2, pooling: 'mean' }),
      vectorConfigJson({ pooling: 'mean', embdNormalize: 2 })
    )
  })
})
