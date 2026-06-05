'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')

const GGMLBert = require('../../index.js')
const HttpDL = require('./http-loader')
const { safeTest } = require('./utils')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

const SHARDED_MODEL = {
  baseUrl: 'https://huggingface.co/gianni-cor/gte-large_fp16-sharded/resolve/main/',
  embeddingDimension: 1024,
  files: [
    {
      name: 'gte-large_fp16.tensors.txt',
      size: 8966
    },
    {
      name: 'gte-large_fp16-00001-of-00005.gguf',
      size: 156815424
    },
    {
      name: 'gte-large_fp16-00002-of-00005.gguf',
      size: 159721216
    },
    {
      name: 'gte-large_fp16-00003-of-00005.gguf',
      size: 159737792
    },
    {
      name: 'gte-large_fp16-00004-of-00005.gguf',
      size: 159721120
    },
    {
      name: 'gte-large_fp16-00005-of-00005.gguf',
      size: 33608768
    }
  ]
}

async function ensureShardedModel (modelDir) {
  fs.mkdirSync(modelDir, { recursive: true })

  const loader = new HttpDL({ baseUrl: SHARDED_MODEL.baseUrl })
  try {
    for (const file of SHARDED_MODEL.files) {
      const dest = path.join(modelDir, file.name)
      if (fs.existsSync(dest)) {
        const stat = fs.statSync(dest)
        if (stat.size === file.size) {
          continue
        }
        console.log(`[download] Removing incomplete shard: ${file.name} (${stat.size} bytes)`)
        fs.unlinkSync(dest)
      }

      console.log(`[download] Downloading sharded embed model file: ${file.name}`)
      const stream = await loader.getStream(file.name)
      const ws = fs.createWriteStream(dest)
      for await (const chunk of stream) {
        ws.write(chunk)
      }
      ws.end()
      await new Promise(resolve => ws.on('close', resolve))

      const stat = fs.statSync(dest)
      if (stat.size !== file.size) {
        fs.unlinkSync(dest)
        throw new Error(`${file.name}: expected ${file.size} bytes, got ${stat.size}`)
      }
    }
  } finally {
    await loader.close().catch(() => {})
  }

  return SHARDED_MODEL.files.map(file => path.join(modelDir, file.name))
}

safeTest('sharded embed model can run inference end-to-end', {
  timeout: 10 * 60 * 1000,
  skip: isMobile
}, async t => {
  const modelDir = path.resolve(__dirname, '../model')
  const modelFiles = await ensureShardedModel(modelDir)

  const addon = new GGMLBert({
    files: { model: modelFiles },
    config: {
      device: 'cpu',
      gpu_layers: '0',
      batch_size: '512',
      ctx_size: '512',
      openclCacheDir: modelDir,
      verbosity: '2'
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    await addon.load()
    const response = await addon.run([
      'That is a happy person',
      'This is a sad person'
    ])
    const embeddings = await response.await()

    t.is(embeddings[0].length, 2, 'should return one embedding per input sequence')
    t.is(
      embeddings[0][0].length,
      SHARDED_MODEL.embeddingDimension,
      'should generate gte-large embeddings with expected dimension'
    )
    t.is(response.stats.backendDevice, 'cpu', 'should report cpu backend')
    t.is(response.stats.context_size, 512, 'should use configured runtime context size')
    t.ok(
      response.stats.trained_context_size >= response.stats.context_size,
      'trained context should be at least the runtime context'
    )
  } finally {
    await addon.unload().catch(() => {})
  }
})
