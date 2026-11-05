'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const GGMLBert = require('../../index.js')
const { downloadFile, verifyModelFile, TestLogger, waitForCompletion } = require('./utils')
const chunks = require('./knowledge-indexing-chunks.json')

const MODEL = {
  name: 'embeddinggemma-300m-Q4_0.gguf',
  url: 'https://huggingface.co/unsloth/embeddinggemma-300m-GGUF/resolve/6661a6504c30d8304af13455cb4a5d4f5bc6011f/embeddinggemma-300m-Q4_0.gguf',
  sha256: 'edc6015cb15694c27be7d1d33f1bc015db9a358ff51ed524628c027504907ba9',
  bytes: 277852192
}

test('Knowledge indexing: CPU flash-attention timing and vector parity for 57 chunks', async (t) => {
  t.timeout(600_000)
  t.is(chunks.length, 57, 'fixed workload size')

  // Frozen rag-extract 0.2.2 output from the app's synthetic 49 KB indexing fixture.
  emit({
    event: 'start',
    chunks: chunks.length,
    characters: chunks.join('').length,
    platform: os.platform(),
    arch: os.arch()
  })
  const preparedAt = Date.now()
  const modelPath = await prepareModel()
  emit({ event: 'model-file', ms: Date.now() - preparedAt, sha256: MODEL.sha256 })

  let baseline
  // Reverse the second pair so one setting does not always run on a hotter device.
  const flashModes = ['off', 'on', 'on', 'off']
  for (const [pass, flashAttention] of flashModes.entries()) {
    const inference = new GGMLBert({
      files: { model: [modelPath] },
      config: {
        device: 'cpu',
        gpu_layers: '0',
        flash_attn: flashAttention,
        batch_size: '1024',
        openclCacheDir: path.dirname(modelPath)
      },
      logger: new TestLogger(),
      opts: { stats: true }
    })
    try {
      const loadAt = Date.now()
      await inference.load()
      emit({ event: 'load', pass, flashAttention, ms: Date.now() - loadAt })

      for (let round = 0; round < 2; round++) {
        const startedAt = Date.now()
        const batchMs = []
        const nativeStats = []
        const vectors = []
        for (let offset = 0; offset < chunks.length; offset += 8) {
          const batch = chunks.slice(offset, offset + 8)
          const batchAt = Date.now()
          const response = await inference.run(batch)
          const embedding = (await waitForCompletion(response)).flat()
          batchMs.push(Date.now() - batchAt)
          nativeStats.push(response.stats)
          t.is(response.stats.backendDevice, 'cpu', 'requested backend actually ran')
          t.is(embedding.length, batch.length, 'one vector per chunk')
          t.ok(
            embedding.every((row) => row.length === 768 && row.every(Number.isFinite)),
            'finite 768-dimensional vectors'
          )
          vectors.push(...embedding)
        }
        const elapsedMs = Date.now() - startedAt
        if (!baseline) baseline = vectors
        const minCosine = Math.min(...vectors.map((row, i) => cosine(row, baseline[i])))
        t.ok(minCosine > 0.999, `matches CPU vectors (minimum cosine ${minCosine})`)
        emit({
          event: 'round',
          pass,
          flashAttention,
          round,
          ms: elapsedMs,
          batchMs,
          nativeStats,
          vectors: vectors.length,
          minCosine
        })
      }
    } finally {
      await inference.unload()
    }
  }
})

async function prepareModel() {
  const dir = path.join(global.testDir || os.tmpdir(), 'test', 'model')
  const modelPath = path.join(dir, MODEL.name)
  if (fs.existsSync(modelPath)) {
    const cached = await verifyModelFile(modelPath, MODEL)
    if (!cached.ok) throw new Error(`Cached embedding model failed verification: ${cached.reason}`)
    return modelPath
  }
  fs.mkdirSync(dir, { recursive: true })
  await downloadFile(MODEL.url, modelPath)
  const downloaded = await verifyModelFile(modelPath, MODEL)
  if (!downloaded.ok) throw new Error(`Embedding model failed verification: ${downloaded.reason}`)
  return modelPath
}

function emit(result) {
  console.log(`[knowledge-indexing] ${JSON.stringify(result)}`)
}

function cosine(a, b) {
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return dot / Math.sqrt(aa * bb)
}
