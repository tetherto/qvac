'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const { QVACRegistryClient } = require('@qvac/registry-client')

const DEFAULT_DISK_PATH = './models'

const RAG_MODELS = {
  embedder: {
    path: 'ChristianAzinn/gte-large-gguf/blob/f9fa5479908e72c2a8b9d6ba112911cd1e51be53/gte-large_fp16.gguf',
    source: 'hf',
    filename: 'gte-large_fp16.gguf'
  },
  llm: {
    path: 'unsloth/Llama-3.2-1B-Instruct-GGUF/blob/b69aef112e9f895e6f98d7ae0949f72ff09aa401/Llama-3.2-1B-Instruct-Q4_0.gguf',
    source: 'hf',
    filename: 'Llama-3.2-1B-Instruct-Q4_0.gguf'
  }
}

async function ensureModels (keys, diskPath) {
  diskPath = diskPath || DEFAULT_DISK_PATH

  const requested = keys.map(key => {
    const model = RAG_MODELS[key]
    if (!model) {
      throw new Error(`Unknown model key: ${key}. Available keys: ${Object.keys(RAG_MODELS).join(', ')}`)
    }
    return { key, ...model, fullPath: path.join(diskPath, model.filename) }
  })

  const missing = requested.filter(m => !fs.existsSync(m.fullPath))

  if (missing.length === 0) {
    console.log('Models already cached locally.')
    return toResult(requested, diskPath)
  }

  fs.mkdirSync(diskPath, { recursive: true })

  console.log('Downloading models from QVAC registry...')
  const client = new QVACRegistryClient()

  try {
    await client.ready()

    for (const m of missing) {
      console.log(`  Downloading ${m.filename}...`)
      await client.downloadModel(m.path, m.source, {
        outputFile: m.fullPath,
        timeout: 300000
      })
      console.log(`  Downloaded: ${m.filename}`)
    }

    console.log('Models ready.')
  } finally {
    await client.close()
  }

  return toResult(requested, diskPath)
}

function toResult (requested, diskPath) {
  const out = {}
  for (const m of requested) {
    out[m.key] = { filename: m.filename, dir: diskPath, fullPath: m.fullPath }
  }
  return out
}

module.exports = { ensureModels, RAG_MODELS, DEFAULT_DISK_PATH }
