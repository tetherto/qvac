import test from 'brittle'
import { decideParamsSchema } from '@/schemas/decide'
import {
  loadBuiltinModelOptionsBaseSchema,
  loadDecisionModelRequestSchema
} from '@/schemas/load-model'

const noul = {
  modelId: 'm',
  state: 'The capital of France is Paris.',
  questions: { truth: { type: 'noul', instructions: 'Is the statement true?' } }
}

test('decideParamsSchema accepts a noul question without criteria', (t) => {
  t.is(decideParamsSchema.safeParse(noul).success, true)
})

test('decideParamsSchema accepts images as the extension hook', (t) => {
  const result = decideParamsSchema.safeParse({ ...noul, images: ['data:image/png;base64,aa'] })
  t.is(result.success, true)
})

test('decideParamsSchema rejects a null state', (t) => {
  t.is(decideParamsSchema.safeParse({ ...noul, state: null }).success, false)
})

test('decideParamsSchema rejects an empty questions object', (t) => {
  t.is(decideParamsSchema.safeParse({ ...noul, questions: {} }).success, false)
})

test('decideParamsSchema rejects an unknown question type', (t) => {
  t.is(
    decideParamsSchema.safeParse({
      ...noul,
      questions: { q: { type: 'unknown', instructions: 'x' } }
    }).success,
    false
  )
})

test('decideParamsSchema accepts a choice with one option', (t) => {
  const result = decideParamsSchema.safeParse({
    modelId: 'm',
    state: 'hello',
    questions: {
      q: { type: 'choice', instructions: 'Pick one', criteria: { only: 'a single option' } }
    }
  })
  t.is(result.success, true)
})

test('decideParamsSchema rejects an empty choice criteria object', (t) => {
  t.is(
    decideParamsSchema.safeParse({
      modelId: 'm',
      state: 'hello',
      questions: { q: { type: 'choice', instructions: 'x', criteria: {} } }
    }).success,
    false
  )
})

test('decideParamsSchema rejects a score scale shorter than 2 or longer than 10', (t) => {
  t.is(
    decideParamsSchema.safeParse({
      modelId: 'm',
      state: 'hello',
      questions: { q: { type: 'score', instructions: 'x', criteria: ['only one'] } }
    }).success,
    false
  )
  const levels = Array.from({ length: 11 }, (_, i) => `level ${i}`)
  t.is(
    decideParamsSchema.safeParse({
      modelId: 'm',
      state: 'hello',
      questions: { q: { type: 'score', instructions: 'x', criteria: levels } }
    }).success,
    false
  )
})

test('loadDecisionModelRequestSchema accepts the canonical type and an optional config', (t) => {
  t.is(
    loadDecisionModelRequestSchema.safeParse({
      type: 'loadModel',
      modelSrc: '/tmp/Laya-Q8_0.gguf',
      modelType: 'llamacpp-decision'
    }).success,
    true
  )
  t.is(
    loadDecisionModelRequestSchema.safeParse({
      type: 'loadModel',
      modelSrc: '/tmp/Laya-Q8_0.gguf',
      modelType: 'llamacpp-decision',
      modelConfig: { device: 'cpu', verbosity: 1 }
    }).success,
    true
  )
})

test('loadBuiltinModelOptionsBaseSchema accepts the decision alias', (t) => {
  t.is(
    loadBuiltinModelOptionsBaseSchema.safeParse({
      modelSrc: '/tmp/Laya-Q8_0.gguf',
      modelType: 'decision'
    }).success,
    true
  )
})
