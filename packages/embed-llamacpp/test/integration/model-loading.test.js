'use strict'

const binding = require('../../binding.js')
const test = require('brittle')
const { LayaDecisions, Reranker } = require('../../index.js')

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')

const GGMLBert = require('../../index.js')
const { attachSpecLogger } = require('./spec-logger')
const { downloadFile, verifyModelFileOnce, safeTest } = require('./utils')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

// gte-large fp16 split into five GGUF shards, at a pinned revision. A disk
// load needs only the shards, so this repo has no .tensors.txt. Kept out of
// models.manifest.json: mobile pre-staging stages every manifest model, and
// these tests do not run on mobile.
const DISK_SHARDED_MODEL = {
  baseUrl:
    'https://huggingface.co/opaninakuffo/gte-large-fp16-sharded/resolve/3bbd084b9475ccc82ec067c8939c2a0384ac03c4/',
  embeddingDimension: 1024,
  shards: [
    {
      name: 'gte-large_fp16-00001-of-00005.gguf',
      bytes: 156815424,
      sha256: '81c871b0433ed75adb4b1888f4396248c0a587f509f45050b2b65de9b8e86a3b'
    },
    {
      name: 'gte-large_fp16-00002-of-00005.gguf',
      bytes: 159721216,
      sha256: 'da7f5a2e0ba4f6769599cb7d2735f19a8022eb065973d7584081cf67617a064d'
    },
    {
      name: 'gte-large_fp16-00003-of-00005.gguf',
      bytes: 159737792,
      sha256: 'd95b830af36d2dfa1d4c7c156ac59be767a5f9b5d37288533d3add7a90ec3822'
    },
    {
      name: 'gte-large_fp16-00004-of-00005.gguf',
      bytes: 159721120,
      sha256: '6def2c28f1b6314403a39c54250d870333d273e31446717f8670a4e1d5861d20'
    },
    {
      name: 'gte-large_fp16-00005-of-00005.gguf',
      bytes: 33608768,
      sha256: 'f5ff10900f675900a1838536746d23ccc6adcfed074f89f7a4ac4d3167401d08'
    }
  ]
}

// llama.cpp logs this per additional split it opens from disk.
const SPLIT_FILE_LOG = 'loading split-file'

// [label, index of the shard passed to GGMLBert]. Only the first shard names
// the split; llama.cpp rejects a load that starts from any other.
const REJECTED_SHARD_CASES = [
  ['a middle shard', 2],
  ['the last shard', 4]
]

let diskShardedModel = null

function ensureDiskShardedModel(modelDir) {
  if (!diskShardedModel) {
    diskShardedModel = downloadDiskShardedModel(modelDir).catch((err) => {
      diskShardedModel = null
      throw err
    })
  }
  return diskShardedModel
}

async function downloadDiskShardedModel(modelDir) {
  fs.mkdirSync(modelDir, { recursive: true })

  for (const shard of DISK_SHARDED_MODEL.shards) {
    const dest = path.join(modelDir, shard.name)
    if (fs.existsSync(dest)) {
      const cached = await verifyModelFileOnce(dest, shard)
      if (cached.ok) continue
      console.log(`[download] ${shard.name}: cached copy failed integrity (${cached.reason})`)
      fs.unlinkSync(dest)
    }

    console.log(`[download] Downloading sharded embed model file: ${shard.name}`)
    await downloadFile([DISK_SHARDED_MODEL.baseUrl + shard.name], dest)

    const res = await verifyModelFileOnce(dest, shard)
    if (!res.ok) {
      fs.unlinkSync(dest)
      throw new Error(`${shard.name}: downloaded file failed integrity: ${res.reason}`)
    }
  }

  return DISK_SHARDED_MODEL.shards.map((shard) => path.join(modelDir, shard.name))
}

function createShardedAddon(shardPath, modelDir) {
  return new GGMLBert({
    files: { model: [shardPath] },
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
}

// Passes the first shard path. Fabric finds the sibling shards by file name
// and reads them from disk.
async function runDiskShardedInference(t, shardPaths, modelDir) {
  const specLogger = attachSpecLogger({ forwardToConsole: true })
  const addon = createShardedAddon(shardPaths[0], modelDir)

  try {
    await addon.load()
    const response = await addon.run(['That is a happy person', 'This is a sad person'])
    const embeddings = await response.await()

    t.is(embeddings[0].length, 2, 'should return one embedding per input sequence')
    t.is(
      embeddings[0][0].length,
      DISK_SHARDED_MODEL.embeddingDimension,
      'should generate gte-large embeddings with expected dimension'
    )
    t.ok(
      embeddings[0].every((vector) => vector.every(Number.isFinite)),
      'every embedding value should be finite'
    )
    t.is(response.stats.backendDevice, 'cpu', 'should report cpu backend')
    t.is(response.stats.context_size, 512, 'should use configured runtime context size')
    t.ok(
      response.stats.trained_context_size >= response.stats.context_size,
      'trained context should be at least the runtime context'
    )

    for (const siblingPath of shardPaths.slice(1)) {
      t.ok(
        specLogger.logs.some((line) => line.includes(`${SPLIT_FILE_LOG} ${siblingPath}`)),
        `${path.basename(siblingPath)} should be loaded from disk`
      )
    }
  } finally {
    specLogger.release()
    await addon.unload().catch(() => {})
  }
}

safeTest(
  'sharded embed model loads from disk given the first shard',
  {
    timeout: 10 * 60 * 1000,
    skip: isMobile
  },
  async (t) => {
    const modelDir = path.resolve(__dirname, '../model')
    const shardPaths = await ensureDiskShardedModel(modelDir)
    await runDiskShardedInference(t, shardPaths, modelDir)
  }
)

for (const [label, shardIndex] of REJECTED_SHARD_CASES) {
  safeTest(
    `sharded embed model rejects a load given ${label}`,
    {
      timeout: 10 * 60 * 1000,
      skip: isMobile
    },
    async (t) => {
      const modelDir = path.resolve(__dirname, '../model')
      const shardPaths = await ensureDiskShardedModel(modelDir)
      const addon = createShardedAddon(shardPaths[shardIndex], modelDir)
      try {
        await t.exception(() => addon.load(), /model initialization returned a null model\/context/)
        t.is(addon.getState().configLoaded, false)
      } finally {
        await addon.unload().catch(() => {})
      }
    }
  )
}

test('native binding does not expose weight streaming', function (t) {
  t.is(binding.loadWeights, undefined)
})

// prestage-ignore: missing-model-00001-of-10000000.gguf — intentionally missing path for the allocation regression
test('all model classes reject missing disk filenames without expanding oversized shard counts', async function (t) {
  for (const Model of [GGMLBert, LayaDecisions, Reranker]) {
    const model = new Model({
      files: { model: [path.resolve(__dirname, 'missing-model-00001-of-10000000.gguf')] },
      config: { device: 'cpu', gpu_layers: '0' }
    })
    try {
      await t.exception(() => model.load(), /Failed to read GGUF metadata from disk/)
      t.is(model.getState().configLoaded, false)
    } finally {
      await model.unload()
    }
  }
})
