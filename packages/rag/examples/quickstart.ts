// End-to-end retrieval-augmented generation: ingest a small knowledge base,
// then stream an answer grounded in the retrieved context.
//
// Run: bare examples/quickstart.ts (build @qvac/rag first: npm run build)

import fs from 'bare-fs'
import url from 'bare-url'
import Corestore from 'corestore'
import EmbedderPlugin from '@qvac/embed-llamacpp'
import LlmPlugin from '@qvac/llm-llamacpp'
import QvacLogger from '@qvac/logging'

import { RAG, HyperDBAdapter, QvacLlmAdapter } from '@qvac/rag'
import { ensureModels } from './utils'

interface StreamResponse {
  onUpdate(callback: (update: string) => void): StreamResponse
  await(): Promise<void>
}

const store = new Corestore('./store')
const query = 'Who won the individual title in LIV Golf UK by JCB in 2025?'

async function main() {
  // 1. Fetch embedder + LLM model files from the QVAC registry (cached on disk after first run).
  const models = await ensureModels(['embedder', 'llm'])

  // 2. Construct embedder with the files-based addon shape.
  const embedder = new EmbedderPlugin({
    files: { model: [models.embedder.fullPath] },
    config: { device: 'gpu', gpu_layers: '99' },
    logger: console,
    opts: { stats: true }
  })
  await embedder.load()

  const embeddingFunction = async (text: string | string[]) => {
    const response = await embedder.run(text)
    const embeddings = await response.await()

    if (Array.isArray(text)) {
      return embeddings[0].map((embedding: Iterable<number>) => Array.from(embedding))
    } else {
      return Array.from(embeddings[0][0]) as number[]
    }
  }

  // 3. Construct LLM with the files-based addon shape.
  const llm = new LlmPlugin({
    files: { model: [models.llm.fullPath] },
    config: { device: 'gpu', gpu_layers: '99', ctx_size: '1024' },
    logger: console,
    opts: { stats: true }
  })
  await llm.load()
  const llmAdapter = new QvacLlmAdapter(llm)

  const dbAdapter = new HyperDBAdapter({ store })
  const logger = new QvacLogger(console)

  const rag = new RAG({ embeddingFunction, dbAdapter, llm: llmAdapter, logger })
  await rag.ready()

  const knowledgeBasePath = url.fileURLToPath(new URL('knowledge-base.json', import.meta.url))
  const knowledgeBase: Array<{ text: string }> = JSON.parse(
    fs.readFileSync(knowledgeBasePath, 'utf8')
  )
  const knowledgeBaseMapped = knowledgeBase.map((kb) => kb.text)

  const docs = await rag.ingest(knowledgeBaseMapped, models.embedder.filename)

  const response = (await rag.infer(query)) as StreamResponse

  let fullResponse = ''
  await response
    .onUpdate((update) => {
      fullResponse += update
    })
    .await()

  console.log(fullResponse)

  const processedIds = docs.processed
    .map((doc) => doc.id)
    .filter((id): id is string => id !== undefined)
  await rag.deleteEmbeddings(processedIds)

  await rag.close()
  await llm.unload()
  await embedder.unload()
  await store.close()
}

main().catch(console.error)
