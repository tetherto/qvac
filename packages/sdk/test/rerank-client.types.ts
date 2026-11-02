import { rerank, type RerankParams, type RerankScores, type LoadModelOptions } from '@/index'

const params: RerankParams = { modelId: 'reranker', query: 'refund', documents: ['a', 'b'] }
const scores: Promise<RerankScores> & { requestId: string } = rerank(params)
const numbers: Promise<number[]> = rerank(params)
const load: LoadModelOptions = {
  modelSrc: '/models/reranker.gguf',
  modelType: 'llamacpp-rerank',
  modelConfig: { device: 'cpu', threads: 0, backend: ['cuda'] }
}
const defaultLoad: LoadModelOptions = {
  modelSrc: '/models/reranker.gguf',
  modelType: 'llamacpp-rerank'
}
void [scores, numbers, load, defaultLoad]

// @ts-expect-error Documents are strings.
rerank({ modelId: 'reranker', query: 'refund', documents: [1] })
const pooled: LoadModelOptions = {
  modelSrc: '/models/reranker.gguf',
  modelType: 'llamacpp-rerank',
  // @ts-expect-error The reranker fixes its own pooling.
  modelConfig: { pooling: 'rank' }
}
void pooled
