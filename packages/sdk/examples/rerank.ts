import { loadModel, rerank, unloadModel, close } from '@qvac/sdk'

// Any reranker (cross-encoder) GGUF, such as bge-reranker, jina-reranker or Qwen3-Reranker.
const modelSrc =
  process.argv[2] ??
  'https://huggingface.co/ggml-org/models/resolve/499bc8821c6b12b4e53c5bffcb21ec206f212d81/jina-reranker-v1-tiny-en/ggml-model-f16.gguf'

const query = 'How do I get a refund for a duplicate charge?'
const documents = [
  'Refunds for duplicate or failed payments are issued within 5 business days.',
  'Our office is open Monday to Friday, 9am to 5pm.',
  'To change your password, open Settings and choose Security.',
  'If you were charged twice, contact billing with both transaction IDs.'
]

let modelId: string | undefined
try {
  console.error('▸ Loading reranker')
  modelId = await loadModel({ modelSrc, modelType: 'llamacpp-rerank' })
  // One score per document, in input order. Higher is more relevant.
  const scores = await rerank({ modelId, query, documents })
  const ranked = documents
    .map((document, index) => ({ score: scores[index]!, document }))
    .sort((a, b) => b.score - a.score)
  console.log(`Query: ${query}\n`)
  for (const { score, document } of ranked) console.log(`${score.toFixed(3)}  ${document}`)
} catch (error) {
  console.error('✖', error)
  process.exitCode = 1
} finally {
  if (modelId) await unloadModel({ modelId })
  await close()
}
