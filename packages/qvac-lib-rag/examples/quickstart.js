const EmbedderPlugin = require('@qvac/embed-llamacpp')
const LlmPlugin = require('@qvac/llm-llamacpp')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const knowledgeBase = require('./knowledge-base.json')
const { RAG, HyperDBAdapter, QvacLlmAdapter } = require('../index')
const Corestore = require('corestore')
const QvacLogger = require('@qvac/logging')

const llamaDriveKey = 'afa79ee07c0a138bb9f11bfaee771fb1bdfca8c82d961cff0474e49827bd1de3'
const gteDriveKey = 'd1896d9259692818df95bd2480e90c2d057688a4f7c9b1ae13ac7f5ee379d03e'

const modelName = 'gte-large_fp16.gguf'
const store = new Corestore('./store')

const modelDir = './models'

const query = 'Who won the individual title in LIV Golf UK by JCB in 2025?'

async function main () {
  // Load the embedder using HyperDriveDL
  const gteHdDL = new HyperDriveDL({
    key: `hd://${gteDriveKey}`,
    store
  })

  const embedderArgs = {
    loader: gteHdDL,
    opts: { stats: true },
    logger: console,
    diskPath: modelDir,
    modelName
  }
  const embedder = new EmbedderPlugin(embedderArgs, '-ngl\t99\n-dev\tgpu')
  await embedder.load(false)

  const embeddingFunction = async (text) => {
    const response = await embedder.run(text)
    const embeddings = await response.await()

    if (Array.isArray(text)) {
      return embeddings[0].map(embedding => Array.from(embedding))
    } else {
      return Array.from(embeddings[0][0])
    }
  }

  // Load the LLM using HyperDriveDL
  const llamaHdDL = new HyperDriveDL({
    key: `hd://${llamaDriveKey}`,
    store
  })

  const llmArgs = {
    loader: llamaHdDL,
    opts: { stats: true },
    logger: console,
    diskPath: modelDir,
    modelName: 'Llama-3.2-1B-Instruct-Q4_0.gguf'
  }
  const llm = new LlmPlugin(llmArgs, { ctx_size: '1024', gpu_layers: '99', device: 'gpu' })
  await llm.load(false)
  const llmAdapter = new QvacLlmAdapter(llm)

  // Initialize the database adapter
  const dbAdapter = new HyperDBAdapter({ store })

  // Create logger for visibility
  const logger = new QvacLogger(console)

  // Initialize the RAG pipeline
  const rag = new RAG({ embeddingFunction, dbAdapter, llm: llmAdapter, logger })
  await rag.ready()

  const knowledgeBaseMapped = knowledgeBase.map(kb => kb.text)

  // Generate embeddings for the knowledge base and save them to the vector database
  const docs = await rag.ingest(knowledgeBaseMapped, modelName)

  // Generate a response to the user query
  const response = await rag.infer(query)

  let fullResponse = ''
  await response
    .onUpdate(update => {
      fullResponse += update
    })
    .await()

  console.log(fullResponse)

  // Delete the embeddings for the knowledge base
  await rag.deleteEmbeddings(docs.processed.map(doc => doc.id))

  // Close the RAG pipeline
  await rag.close()

  // Close HyperDriveDL instances
  await llamaHdDL.close()
  await gteHdDL.close()

  // Close the store
  await store.close()
}

main().catch(console.error)
