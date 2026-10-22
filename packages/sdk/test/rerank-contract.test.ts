import test from 'brittle'
import { rerankRequestSchema, ModelType } from '@qvac/inference/surface'
import { PLUGIN_RERANK } from '@/plugin-ids'
import { buildContract } from '../scripts/contract/build-contract'
import { contractValidate } from './utils/contract-validator'

test('rerank is a typed unary method in the generated client contract', (t) => {
  const { manifest } = buildContract()
  const method = manifest.methods.find((method) => method.name === 'rerank')
  t.is(method?.callShape, 'request-reply')
  const request = {
    type: 'rerank',
    modelId: 'reranker',
    query: 'How do I get a refund?',
    documents: ['Refunds take 5 days.', 'The office opens at 9am.'],
    requestId: 'rerank-id'
  }
  t.is(rerankRequestSchema.parse(request).requestId, 'rerank-id')
  t.ok(contractValidate('rerank.request', request).valid)
  t.absent(contractValidate('rerank.request', { ...request, documents: [] }).valid)
  t.absent(contractValidate('rerank.request', { ...request, top_n: 1 }).valid)
  t.ok(contractValidate('constants.ModelType', ModelType.llamacppRerank).valid)
  t.ok(contractValidate('constants.PluginId', PLUGIN_RERANK).valid)
})

test('reranker loads accept omitted device in the generated client contract', (t) => {
  const load = {
    type: 'loadModel',
    modelSrc: '/models/reranker.gguf',
    modelType: ModelType.llamacppRerank
  }
  t.ok(contractValidate('loadModel.request', load).valid)
  t.ok(contractValidate('loadModel.request', { ...load, modelConfig: {} }).valid)
  t.ok(contractValidate('loadModel.request', { ...load, modelConfig: { device: 'cpu' } }).valid)
})
