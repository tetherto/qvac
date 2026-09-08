'use strict'

const os = require('bare-os')
const path = require('bare-path')
const process = require('bare-process')

const GGMLBert = require('../index')
const IdMapIndex = require('../idMapIndex')
const { downloadModel } = require('./utils')

const MODEL_URL =
  'https://huggingface.co/unsloth/embeddinggemma-300m-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf'
const MODEL_NAME = 'embeddinggemma-300M-Q8_0.gguf'

function normalize (embedding) {
  const normalized = new Float32Array(embedding.length)
  let norm = 0

  for (let i = 0; i < embedding.length; i++) {
    norm += embedding[i] * embedding[i]
  }

  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < embedding.length; i++) {
    normalized[i] = embedding[i] / norm
  }
  return normalized
}

function flatten (embeddings) {
  const dim = embeddings[0].length
  const flattened = new Float32Array(embeddings.length * dim)

  for (let i = 0; i < embeddings.length; i++) {
    flattened.set(normalize(embeddings[i]), i * dim)
  }
  return flattened
}

async function main () {
  if (os.arch() !== 's390x' && !os.arch().includes('64')) {
    throw new Error(`TurboVec requires a 64-bit desktop; detected ${os.arch()}`)
  }

  const documents = [
    { id: 1n, text: 'Saturn moon Titan has lakes, clouds, and rain made of liquid methane.' },
    { id: 2n, text: 'Solar panels convert sunlight into electricity using photovoltaic cells.' },
    { id: 3n, text: 'Honeybees communicate the location of flowers through a waggle dance.' },
    { id: 4n, text: 'The Pacific Ocean is the largest and deepest ocean on Earth.' }
  ]
  const documentsById = new Map(documents.map(document => [document.id, document]))
  const queryText = 'Which moon has methane rain and lakes?'

  const [modelName, modelDir] = await downloadModel(MODEL_URL, MODEL_NAME)
  const model = new GGMLBert({
    files: { model: [path.join(modelDir, modelName)] },
    config: {
      device: 'cpu',
      gpu_layers: '0',
      batch_size: '1024',
      openclCacheDir: modelDir
    },
    logger: console,
    opts: { stats: true }
  })

  let index = null
  await model.load()

  try {
    const inputs = [...documents.map(document => document.text), queryText]
    const response = await model.run(inputs)
    const embeddings = (await response.await())[0]
    const documentEmbeddings = flatten(embeddings.slice(0, documents.length))
    const queryEmbedding = normalize(embeddings[documents.length])

    index = new IdMapIndex({
      dim: queryEmbedding.length,
      storage: 'turbovec-q4'
    })
    index.addWithIds(
      documentEmbeddings,
      new BigUint64Array(documents.map(document => document.id))
    )
    index.prepare()

    const result = index.search(queryEmbedding, 2)
    const matches = Array.from(result.ids)
      .map((id, position) => ({
        document: documentsById.get(id),
        score: result.scores[position]
      }))
      .filter(match => match.document !== undefined)

    const context = matches.map(match => match.document.text).join('\n')

    console.log('\nQuery:')
    console.log(queryText)
    console.log('\nRetrieved chunks:')
    for (const match of matches) {
      console.log(`- score=${match.score.toFixed(4)} id=${match.document.id}: ${match.document.text}`)
    }
    console.log('\nContext to pass to an LLM:')
    console.log(context)
  } finally {
    if (index !== null) index.dispose()
    await model.unload()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
