'use strict'

const test = require('brittle')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const RegistryDatabase = require('../../shared/db')

const TEST_MODELS = [
  {
    path: 'models/llama-3.2-1b-instruct-q4_k_m.gguf',
    source: 'https://huggingface.co/example/llama-3.2',
    engine: '@qvac/llm-llamacpp',
    licenseId: 'Llama-3.2',
    quantization: 'q4_k_m',
    blobBinding: { coreKey: Buffer.alloc(32), blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 100, sha256: 'aaa' }
  },
  {
    path: 'models/llama-3.2-1b-instruct-q8_0.gguf',
    source: 'https://huggingface.co/example/llama-3.2',
    engine: '@qvac/llm-llamacpp',
    licenseId: 'Llama-3.2',
    quantization: 'q8_0',
    blobBinding: { coreKey: Buffer.alloc(32), blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 200, sha256: 'bbb' }
  },
  {
    path: 'models/whisper-tiny-q5_1.bin',
    source: 'https://huggingface.co/example/whisper-tiny',
    engine: '@qvac/transcription-whispercpp',
    licenseId: 'MIT',
    quantization: 'q5_1',
    blobBinding: { coreKey: Buffer.alloc(32), blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 300, sha256: 'ccc' }
  },
  {
    path: 'models/salamandrata-2b-q4_k_m.gguf',
    source: 'https://huggingface.co/example/salamandrata',
    engine: '@qvac/translation-llamacpp',
    licenseId: 'Apache-2.0',
    quantization: 'q4_k_m',
    blobBinding: { coreKey: Buffer.alloc(32), blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 400, sha256: 'ddd' }
  },
  {
    path: 'models/deprecated-model.gguf',
    source: 'https://huggingface.co/example/old-model',
    engine: '@qvac/llm-llamacpp',
    licenseId: 'MIT',
    quantization: 'q4_k_m',
    deprecated: true,
    deprecatedAt: '2025-01-01T00:00:00.000Z',
    deprecationReason: 'Superseded',
    blobBinding: { coreKey: Buffer.alloc(32), blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 50, sha256: 'eee' }
  }
]

async function createDB (t) {
  const storage = await tmp(t)
  const store = new Corestore(storage)
  await store.ready()

  const core = store.get({ name: 'test-registry' })
  await core.ready()

  const db = new RegistryDatabase(core)
  await db.ready()

  for (const model of TEST_MODELS) {
    await db.putModel(model)
  }

  return { db, store }
}

async function cleanup ({ db, store }) {
  await db.close()
  await store.close()
}

test('findBy() - no filters returns all non-deprecated models', async t => {
  const ctx = await createDB(t)

  try {
    const models = await ctx.db.findBy()
    t.is(models.length, 4, 'returns 4 non-deprecated models')
    t.absent(models.find(m => m.deprecated), 'no deprecated models')
  } finally {
    await cleanup(ctx)
  }
})

test('findBy() - includeDeprecated returns all models', async t => {
  const ctx = await createDB(t)

  try {
    const models = await ctx.db.findBy({ includeDeprecated: true })
    t.is(models.length, 5, 'returns all 5 models including deprecated')
    t.ok(models.find(m => m.deprecated), 'includes deprecated model')
  } finally {
    await cleanup(ctx)
  }
})

test('findBy({ engine }) - filters by engine', async t => {
  const ctx = await createDB(t)

  try {
    const llmModels = await ctx.db.findBy({ engine: '@qvac/llm-llamacpp' })
    t.is(llmModels.length, 2, 'returns 2 non-deprecated llm models')
    t.ok(llmModels.every(m => m.engine === '@qvac/llm-llamacpp'), 'all have correct engine')

    const whisperModels = await ctx.db.findBy({ engine: '@qvac/transcription-whispercpp' })
    t.is(whisperModels.length, 1, 'returns 1 whisper model')
    t.is(whisperModels[0].engine, '@qvac/transcription-whispercpp', 'correct engine')

    const noModels = await ctx.db.findBy({ engine: '@qvac/nonexistent' })
    t.is(noModels.length, 0, 'returns empty for unknown engine')
  } finally {
    await cleanup(ctx)
  }
})

test('findBy({ engine }) - with includeDeprecated', async t => {
  const ctx = await createDB(t)

  try {
    const models = await ctx.db.findBy({ engine: '@qvac/llm-llamacpp', includeDeprecated: true })
    t.is(models.length, 3, 'returns 3 llm models including deprecated')
  } finally {
    await cleanup(ctx)
  }
})

test('findBy({ quantization }) - filters by quantization', async t => {
  const ctx = await createDB(t)

  try {
    const q4Models = await ctx.db.findBy({ quantization: 'q4_k_m' })
    t.is(q4Models.length, 2, 'returns 2 non-deprecated q4_k_m models')
    t.ok(q4Models.every(m => m.quantization?.toLowerCase().includes('q4_k_m')), 'all match quantization')

    const q8Models = await ctx.db.findBy({ quantization: 'q8_0' })
    t.is(q8Models.length, 1, 'returns 1 q8_0 model')
  } finally {
    await cleanup(ctx)
  }
})

test('findBy({ engine, quantization }) - compound filter uses index', async t => {
  const ctx = await createDB(t)

  try {
    const models = await ctx.db.findBy({ engine: '@qvac/llm-llamacpp', quantization: 'q4_k_m' })
    t.is(models.length, 1, 'returns 1 non-deprecated llm + q4_k_m model')
    t.is(models[0].engine, '@qvac/llm-llamacpp', 'correct engine')
    t.is(models[0].quantization, 'q4_k_m', 'correct quantization')

    const models2 = await ctx.db.findBy({ engine: '@qvac/llm-llamacpp', quantization: 'q8_0' })
    t.is(models2.length, 1, 'returns 1 llm + q8_0 model')
    t.is(models2[0].quantization, 'q8_0', 'correct quantization')

    const noModels = await ctx.db.findBy({ engine: '@qvac/transcription-whispercpp', quantization: 'q4_k_m' })
    t.is(noModels.length, 0, 'returns empty for non-matching combo')
  } finally {
    await cleanup(ctx)
  }
})

test('findBy({ engine, quantization, includeDeprecated }) - compound with deprecated', async t => {
  const ctx = await createDB(t)

  try {
    const models = await ctx.db.findBy({
      engine: '@qvac/llm-llamacpp',
      quantization: 'q4_k_m',
      includeDeprecated: true
    })
    t.is(models.length, 2, 'returns 2 llm + q4_k_m models including deprecated')
  } finally {
    await cleanup(ctx)
  }
})

test('findBy({ name }) - filters by name from path', async t => {
  const ctx = await createDB(t)

  try {
    const models = await ctx.db.findBy({ name: 'llama' })
    t.is(models.length, 2, 'returns 2 models matching llama')
    t.ok(models.every(m => m.path.toLowerCase().includes('llama')), 'all paths contain llama')

    const whisperModels = await ctx.db.findBy({ name: 'whisper' })
    t.is(whisperModels.length, 1, 'returns 1 model matching whisper')

    const noModels = await ctx.db.findBy({ name: 'nonexistent' })
    t.is(noModels.length, 0, 'returns empty for no match')
  } finally {
    await cleanup(ctx)
  }
})

test('findBy({ engine, name }) - engine index + name in-memory filter', async t => {
  const ctx = await createDB(t)

  try {
    const models = await ctx.db.findBy({ engine: '@qvac/llm-llamacpp', name: 'q8' })
    t.is(models.length, 1, 'returns 1 model matching llm engine + q8 name')
    t.is(models[0].quantization, 'q8_0', 'correct model found')
  } finally {
    await cleanup(ctx)
  }
})

test('findModelsByEngineQuantization() - direct compound index access', async t => {
  const ctx = await createDB(t)

  try {
    const models = await ctx.db.findModelsByEngineQuantization({
      gte: { engine: '@qvac/llm-llamacpp', quantization: 'q4_k_m' },
      lte: { engine: '@qvac/llm-llamacpp', quantization: 'q4_k_m' }
    }).toArray()

    t.ok(models.length >= 1, 'returns models from compound index')
    t.ok(models.every(m => m.engine === '@qvac/llm-llamacpp'), 'all have correct engine')
  } finally {
    await cleanup(ctx)
  }
})
