'use strict'

const Corestore = require('corestore')
const EmbedderPlugin = require('@qvac/embed-llamacpp')
const LlmPlugin = require('@qvac/llm-llamacpp')
const QvacLogger = require('@qvac/logging')

const { RAG, HyperDBAdapter, QvacLlmAdapter } = require('../index')
const knowledgeBase = require('./knowledge-base.json')
const { ensureModels } = require('./utils')

const store = new Corestore('./store')
const query = 'Who won the individual title in LIV Golf UK by JCB in 2025?'

async function main () {
  // 1. Fetch embedder + LLM model files from the QVAC registry (cached on disk after first run).
  const models = await ensureModels(['embedder', 'llm'])

  // 2. Construct embedder with the new files-based addon shape.
  const embedder = new EmbedderPlugin({
    files: { model: [models.embedder.fullPath] },
    config: { device: 'gpu', gpu_layers: '99' },
    logger: console,
    opts: { stats: true }
  })
  await embedder.load()

  const embeddingFunction = async (text) => {
    const response = await embedder.run(text)
    const embeddings = await response.await()

    if (Array.isArray(text)) {
      return embeddings[0].map(embedding => Array.from(embedding))
    } else {
      return Array.from(embeddings[0][0])
    }
  }

  // 3. Construct LLM with the new files-based addon shape.
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

  const knowledgeBaseMapped = knowledgeBase.map(kb => kb.text)

  const docs = await rag.ingest(knowledgeBaseMapped, models.embedder.filename)

  const response = await rag.infer(query)

  let fullResponse = ''
  await response
    .onUpdate(update => {
      fullResponse += update
    })
    .await()

  console.log(fullResponse)

  await rag.deleteEmbeddings(docs.processed.map(doc => doc.id))

  await rag.close()
  await llm.unload()
  await embedder.unload()
  await store.close()
}

main().catch(console.error)
