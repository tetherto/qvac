'use strict'

const test = require('brittle')
const Corestore = require('corestore')
const Hyperblobs = require('hyperblobs')
const Hyperswarm = require('hyperswarm')
const createTestnet = require('hyperdht/testnet')
const fs = require('fs').promises
const path = require('path')
const crypto = require('crypto')

const RegistryService = require('../../lib/registry-service')
const RegistryConfig = require('../../lib/config')
const { AUTOBASE_NAMESPACE, QVAC_MAIN_REGISTRY } = require('../../shared/constants')
const { createTempStorage, waitFor } = require('../helpers/test-utils')
const { buildGguf, buildSafetensors } = require('../helpers/gguf-fixture')
const { fitBlobContent } = require('../../lib/fit-blob')

const DISPATCH_ADD_INDEXER = `@${QVAC_MAIN_REGISTRY}/add-indexer`
const DISPATCH_PUT_MODEL = `@${QVAC_MAIN_REGISTRY}/put-model`

const noopLogger = {
  info() {},
  debug() {},
  error() {},
  warn() {}
}

// Tiny model from HuggingFace (~1MB) for integration testing
const TEST_MODEL_URL =
  'https://huggingface.co/klosax/tinyllamas-stories-gguf/resolve/main/tinyllamas-stories-260k-f32.gguf'

async function createService(t, { storage, bootstrap, swarmBootstrap } = {}) {
  const basePath = storage || (await createTempStorage(t))
  const store = new Corestore(basePath)
  await store.ready()

  const swarm = new Hyperswarm({ bootstrap: swarmBootstrap || [] })
  const config = new RegistryConfig({ logger: noopLogger })

  const service = new RegistryService(store.namespace(AUTOBASE_NAMESPACE), swarm, config, {
    logger: noopLogger,
    ackInterval: 5,
    autobaseBootstrap: bootstrap || null,
    skipStorageCheck: true
  })

  return { service, store, swarm, config, storage: basePath }
}

async function cleanupService({ service, store, swarm }) {
  if (service && service.opened) {
    await service.close()
  }
  if (swarm) {
    await swarm.destroy().catch(() => {})
  }
  if (store) {
    await store.close().catch(() => {})
  }
}

test('RegistryService initializes with Autobase', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })

  try {
    t.not(ctx.service.opened, 'service starts closed')
    await ctx.service.ready()
    t.ok(ctx.service.opened, 'service opens via ready()')
    t.ok(ctx.service.base, 'autobase instance available')
    t.ok(ctx.service.registryDiscoveryKey, 'view discovery key exposed')
    t.ok(ctx.service.registryCoreKey, 'view key exposed')
  } finally {
    await cleanupService(ctx)
  }
})

test('Multiple writers replicate through Autobase', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const writer1 = await createService(t, { swarmBootstrap: bootstrap })
  await writer1.service.ready()
  await ensureIndexer(writer1.service)

  const writer2 = await createService(t, {
    bootstrap: writer1.service.base.key,
    swarmBootstrap: bootstrap
  })
  await writer2.service.ready()

  const writer3 = await createService(t, {
    bootstrap: writer1.service.base.key,
    swarmBootstrap: bootstrap
  })
  await writer3.service.ready()

  try {
    await waitForConnection(writer1.swarm, writer2.swarm)
    await waitForConnection(writer1.swarm, writer3.swarm)

    await writer1.service._appendOperation(DISPATCH_ADD_INDEXER, {
      key: writer2.service.base.local.key
    })
    await flushAutobases(writer1.service.base, writer2.service.base)
    // lunte-disable-next-line require-await
    await waitFor(async () => writer2.service.base.isIndexer === true, 15000)

    await writer1.service._appendOperation(DISPATCH_ADD_INDEXER, {
      key: writer3.service.base.local.key
    })
    await flushAutobases(writer1.service.base, writer3.service.base)
    // lunte-disable-next-line require-await
    await waitFor(async () => writer3.service.base.isIndexer === true, 15000)

    // Writer1 adds a model - using real HuggingFace URL
    await writer1.service.addModel({
      source: TEST_MODEL_URL,
      engine: '@test/tinyllamas',
      licenseId: 'MIT'
    })

    await flushAutobases(writer1.service.base, writer2.service.base, writer3.service.base)

    // All writers should see the model after replication
    await waitFor(async () => {
      const [a, b, c] = await Promise.all([
        writer1.service.listModels(),
        writer2.service.listModels(),
        writer3.service.listModels()
      ])
      return a.length === 1 && b.length === 1 && c.length === 1
    }, 30000)

    const models1 = await writer1.service.listModels()
    const models2 = await writer2.service.listModels()
    const models3 = await writer3.service.listModels()

    t.is(models1.length, 1, 'writer1 sees model')
    t.is(models2.length, 1, 'writer2 sees model via replication')
    t.is(models3.length, 1, 'writer3 sees model via replication')
    t.is(models1[0].engine, '@test/tinyllamas', 'model has correct engine')

    // Verify GGUF metadata extraction and replication
    const model = await writer2.service.getModelByKey({
      path: models1[0].path,
      source: models1[0].source
    })
    t.ok(model, 'model retrieved')
    t.ok(model.ggufMetadata, 'GGUF metadata extracted')
    const metadata = JSON.parse(model.ggufMetadata)
    t.is(metadata['general.architecture'], 'llama', 'architecture detected')
    t.ok(metadata['llama.context_length'], 'context length present')
  } finally {
    await cleanupService(writer1)
    await cleanupService(writer2)
    await cleanupService(writer3)
  }
})

test('License collection CRUD operations', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const licenseRecord = {
      spdxId: 'MIT',
      name: 'MIT License',
      url: 'https://opensource.org/licenses/MIT',
      text: 'MIT License\n\nCopyright (c) [year] [fullname]\n\nPermission is hereby granted...'
    }

    await ctx.service.putLicense(licenseRecord)
    await flushAutobases(ctx.service.base)

    const retrieved = await ctx.service.view.getLicense('MIT')
    t.ok(retrieved, 'license retrieved')
    t.is(retrieved.spdxId, 'MIT', 'spdxId matches')
    t.is(retrieved.name, 'MIT License', 'name matches')
    t.is(retrieved.url, 'https://opensource.org/licenses/MIT', 'url matches')
    t.ok(retrieved.text.includes('MIT License'), 'text contains license content')

    const allLicenses = await ctx.service.view.findLicenses({}).toArray()
    t.ok(allLicenses.length >= 1, 'at least one license found')
    t.ok(
      allLicenses.some((l) => l.spdxId === 'MIT'),
      'MIT license in list'
    )
  } finally {
    await cleanupService(ctx)
  }
})

test('Model with licenseId can fetch license info', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const licenseRecord = {
      spdxId: 'Apache-2.0',
      name: 'Apache License 2.0',
      url: 'https://opensource.org/licenses/Apache-2.0',
      text: 'Apache License\nVersion 2.0, January 2004...'
    }

    await ctx.service.putLicense(licenseRecord)
    await flushAutobases(ctx.service.base)

    await ctx.service.addModel({
      source: TEST_MODEL_URL,
      engine: '@test/tinyllamas',
      licenseId: 'Apache-2.0'
    })

    await flushAutobases(ctx.service.base)

    const models = await ctx.service.listModels()
    t.is(models.length, 1, 'model added')
    t.is(models[0].licenseId, 'Apache-2.0', 'model has licenseId')

    const license = await ctx.service.view.getLicense('Apache-2.0')
    t.ok(license, 'license retrieved')
    t.is(license.spdxId, 'Apache-2.0', 'license spdxId matches model licenseId')
    t.ok(license.text.length > 0, 'license text present')
  } finally {
    await cleanupService(ctx)
  }
})

test('License RPC methods work', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const licenseRecord = {
      spdxId: 'GPL-3.0',
      name: 'GNU General Public License v3.0',
      url: 'https://www.gnu.org/licenses/gpl-3.0.html',
      text: 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007...'
    }

    await ctx.service.putLicense(licenseRecord)
    await flushAutobases(ctx.service.base)

    const getResult = await ctx.service.getLicenseByKey({ spdxId: 'GPL-3.0' })
    t.ok(getResult, 'getLicenseByKey returns license')
    t.is(getResult.spdxId, 'GPL-3.0', 'correct license retrieved')

    const listResult = await ctx.service.listLicenses()
    t.ok(Array.isArray(listResult), 'listLicenses returns array')
    t.ok(listResult.length >= 1, 'at least one license in list')
    t.ok(
      listResult.some((l) => l.spdxId === 'GPL-3.0'),
      'GPL-3.0 license in list'
    )
  } finally {
    await cleanupService(ctx)
  }
})

test('update-model-metadata preserves blobBinding', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    // Create test model artifact
    const tempDir = await createTempStorage(t)
    const artifactPath = path.join(tempDir, 'model.bin')
    const modelPayload = Buffer.from('test-model-payload')
    await fs.writeFile(artifactPath, modelPayload)

    ctx.service._downloadArtifact = async (sourceInfo, localPath) => {
      await fs.copyFile(artifactPath, localPath)
      return localPath
    }

    const model = await ctx.service.addModel({
      source: 's3://test-bucket/model.bin',
      engine: '@test/engine',
      licenseId: 'MIT'
    })

    await flushAutobases(ctx.service.base)
    const originalBlobBinding = model.blobBinding

    // Update metadata via dispatch (same path as RPC handler)
    const existing = await ctx.service.getModelByKey({ path: model.path, source: model.source })
    const updated = {
      ...existing,
      description: 'Updated description',
      tags: ['new-tag']
    }
    await ctx.service._appendOperation(DISPATCH_PUT_MODEL, updated)
    await flushAutobases(ctx.service.base)

    const retrieved = await ctx.service.getModelByKey({ path: model.path, source: model.source })
    t.ok(retrieved, 'model retrieved after update')
    t.is(retrieved.description, 'Updated description', 'description updated')
    t.alike(retrieved.tags, ['new-tag'], 'tags updated')
    t.alike(retrieved.blobBinding, originalBlobBinding, 'blobBinding unchanged')
  } finally {
    await cleanupService(ctx)
  }
})

test('_ensureLicense auto-creates missing license', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const licenseBefore = await ctx.service.getLicenseByKey({ spdxId: 'MIT' })
    t.absent(licenseBefore, 'license does not exist initially')

    const tempDir = await createTempStorage(t)
    const artifactPath = path.join(tempDir, 'model.bin')
    const modelPayload = Buffer.from('test-model-payload')
    await fs.writeFile(artifactPath, modelPayload)

    ctx.service._downloadArtifact = async (sourceInfo, localPath) => {
      await fs.copyFile(artifactPath, localPath)
      return localPath
    }

    await ctx.service.addModel({
      source: 's3://test-bucket/model.bin',
      engine: '@test/engine',
      licenseId: 'MIT'
    })

    await flushAutobases(ctx.service.base)

    const licenseAfter = await ctx.service.getLicenseByKey({ spdxId: 'MIT' })
    t.ok(licenseAfter, 'license auto-created')
    t.is(licenseAfter.spdxId, 'MIT', 'correct license ID')
    t.ok(licenseAfter.text, 'license text present')
  } finally {
    await cleanupService(ctx)
  }
})

test('addModel with skipExisting skips existing models', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const tempDir = await createTempStorage(t)
    const artifactPath = path.join(tempDir, 'model.bin')
    await fs.writeFile(artifactPath, Buffer.from('test-model-payload'))

    let downloadCount = 0
    ctx.service._downloadArtifact = async (sourceInfo, localPath) => {
      downloadCount++
      await fs.copyFile(artifactPath, localPath)
      return localPath
    }

    // First add
    const model1 = await ctx.service.addModel({
      source: 's3://test-bucket/skip-test.bin',
      engine: '@test/engine',
      licenseId: 'MIT'
    })
    await flushAutobases(ctx.service.base)

    t.is(downloadCount, 1, 'downloaded once')
    t.ok(model1.path, 'model added')

    // Second add with skipExisting
    const model2 = await ctx.service.addModel(
      {
        source: 's3://test-bucket/skip-test.bin',
        engine: '@test/engine',
        licenseId: 'MIT'
      },
      { skipExisting: true }
    )
    await flushAutobases(ctx.service.base)

    t.is(downloadCount, 1, 'no additional download with skipExisting')
    t.is(model2.path, model1.path, 'returned existing model')

    const models = await ctx.service.listModels()
    t.is(models.length, 1, 'still only one model')
  } finally {
    await cleanupService(ctx)
  }
})

test('deleteModel removes model from database', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const tempDir = await createTempStorage(t)
    const artifactPath = path.join(tempDir, 'model.bin')
    await fs.writeFile(artifactPath, Buffer.from('test-model-payload'))

    ctx.service._downloadArtifact = async (sourceInfo, localPath) => {
      await fs.copyFile(artifactPath, localPath)
      return localPath
    }

    const model = await ctx.service.addModel({
      source: 's3://test-bucket/delete-test.bin',
      engine: '@test/engine',
      licenseId: 'MIT'
    })
    await flushAutobases(ctx.service.base)

    const modelsBefore = await ctx.service.listModels()
    t.is(modelsBefore.length, 1, 'model exists before delete')

    await ctx.service.deleteModel({ path: model.path, source: model.source })
    await flushAutobases(ctx.service.base)

    const modelsAfter = await ctx.service.listModels()
    t.is(modelsAfter.length, 0, 'model removed after delete')

    const retrieved = await ctx.service.getModelByKey({ path: model.path, source: model.source })
    t.absent(retrieved, 'model not found after delete')
  } finally {
    await cleanupService(ctx)
  }
})

test('deleteModel throws for non-existent model', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    await t.exception(
      // lunte-disable-next-line require-await
      async () => ctx.service.deleteModel({ path: 'non/existent/model', source: 's3' }),
      /Model not found/,
      'throws for non-existent model'
    )
  } finally {
    await cleanupService(ctx)
  }
})

test('update-model-metadata handles deprecation fields', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const tempDir = await createTempStorage(t)
    const artifactPath = path.join(tempDir, 'model.bin')
    await fs.writeFile(artifactPath, Buffer.from('test-model-payload'))

    ctx.service._downloadArtifact = async (sourceInfo, localPath) => {
      await fs.copyFile(artifactPath, localPath)
      return localPath
    }

    const model = await ctx.service.addModel({
      source: 's3://test-bucket/deprecation-test.bin',
      engine: '@test/engine',
      licenseId: 'MIT'
    })
    await flushAutobases(ctx.service.base)

    // Verify model starts without deprecation
    const before = await ctx.service.getModelByKey({ path: model.path, source: model.source })
    t.absent(before.deprecated, 'model not deprecated initially')

    // Update with deprecation fields
    const existing = await ctx.service.getModelByKey({ path: model.path, source: model.source })
    const updated = {
      ...existing,
      deprecated: true,
      deprecatedAt: '2025-01-01T00:00:00.000Z',
      replacedBy: 's3://test-bucket/new-model.bin',
      deprecationReason: 'Superseded by new version'
    }
    await ctx.service._appendOperation(DISPATCH_PUT_MODEL, updated)
    await flushAutobases(ctx.service.base)

    const after = await ctx.service.getModelByKey({ path: model.path, source: model.source })
    t.is(after.deprecated, true, 'deprecated flag set')
    t.is(after.deprecatedAt, '2025-01-01T00:00:00.000Z', 'deprecatedAt set')
    t.is(after.replacedBy, 's3://test-bucket/new-model.bin', 'replacedBy set')
    t.is(after.deprecationReason, 'Superseded by new version', 'deprecationReason set')
  } finally {
    await cleanupService(ctx)
  }
})

test('undeprecating model clears deprecation fields', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const tempDir = await createTempStorage(t)
    const artifactPath = path.join(tempDir, 'model.bin')
    await fs.writeFile(artifactPath, Buffer.from('test-model-payload'))

    ctx.service._downloadArtifact = async (sourceInfo, localPath) => {
      await fs.copyFile(artifactPath, localPath)
      return localPath
    }

    const model = await ctx.service.addModel({
      source: 's3://test-bucket/undeprecation-test.bin',
      engine: '@test/engine',
      licenseId: 'MIT'
    })
    await flushAutobases(ctx.service.base)

    // First deprecate the model
    const existing = await ctx.service.getModelByKey({ path: model.path, source: model.source })
    const deprecated = {
      ...existing,
      deprecated: true,
      deprecatedAt: '2025-01-01T00:00:00.000Z',
      replacedBy: 's3://test-bucket/new-model.bin',
      deprecationReason: 'Superseded by new version'
    }
    await ctx.service._appendOperation(DISPATCH_PUT_MODEL, deprecated)
    await flushAutobases(ctx.service.base)

    const afterDeprecate = await ctx.service.getModelByKey({
      path: model.path,
      source: model.source
    })
    t.is(afterDeprecate.deprecated, true, 'model is deprecated')
    t.ok(afterDeprecate.deprecatedAt, 'deprecatedAt is set')
    t.ok(afterDeprecate.replacedBy, 'replacedBy is set')
    t.ok(afterDeprecate.deprecationReason, 'deprecationReason is set')

    // Now undeprecate via the RPC handler logic (simulated)
    const deprecatedModel = await ctx.service.getModelByKey({
      path: model.path,
      source: model.source
    })
    const undeprecated = {
      ...deprecatedModel,
      deprecated: false,
      deprecatedAt: '',
      replacedBy: '',
      deprecationReason: ''
    }
    await ctx.service._appendOperation(DISPATCH_PUT_MODEL, undeprecated)
    await flushAutobases(ctx.service.base)

    const afterUndeprecate = await ctx.service.getModelByKey({
      path: model.path,
      source: model.source
    })
    t.is(afterUndeprecate.deprecated, false, 'model is no longer deprecated')
    t.absent(afterUndeprecate.deprecatedAt, 'deprecatedAt cleared')
    t.absent(afterUndeprecate.replacedBy, 'replacedBy cleared')
    t.absent(afterUndeprecate.deprecationReason, 'deprecationReason cleared')
  } finally {
    await cleanupService(ctx)
  }
})

test('addModel extracts GGUF metadata for .gguf files', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    // Test GGUF file
    const ggufModel = await ctx.service.addModel({
      source: TEST_MODEL_URL,
      engine: '@test/tinyllamas',
      licenseId: 'MIT'
    })
    await flushAutobases(ctx.service.base)

    t.ok(ggufModel.ggufMetadata, 'GGUF metadata extracted')
    const metadata = JSON.parse(ggufModel.ggufMetadata)
    t.is(typeof metadata, 'object', 'metadata is object')
    t.ok(metadata['general.architecture'], 'has architecture field')
    t.ok(Object.keys(metadata).length > 10, 'has multiple metadata fields')

    // Test non-GGUF file
    const tempDir = await createTempStorage(t)
    const artifactPath = path.join(tempDir, 'model.bin')
    await fs.writeFile(artifactPath, Buffer.from('test-payload'))

    ctx.service._downloadArtifact = async (sourceInfo, localPath) => {
      await fs.copyFile(artifactPath, localPath)
    }

    const binModel = await ctx.service.addModel({
      source: 's3://test-bucket/model.bin',
      engine: '@test/engine',
      licenseId: 'MIT'
    })
    await flushAutobases(ctx.service.base)

    t.absent(binModel.ggufMetadata, 'no metadata for non-GGUF file')

    // Verify metadata replicates
    const retrieved = await ctx.service.getModelByKey({
      path: ggufModel.path,
      source: ggufModel.source
    })
    t.alike(retrieved.ggufMetadata, ggufModel.ggufMetadata, 'metadata persisted')
  } finally {
    await cleanupService(ctx)
  }
})

async function addLocalArtifact(ctx, { filename, buffer, engine = '@test/engine' }) {
  const tempDir = await createTempStorage(ctx.t)
  const artifactPath = path.join(tempDir, filename)
  await fs.writeFile(artifactPath, buffer)

  ctx.service._downloadArtifact = async (sourceInfo, localPath) => {
    await fs.copyFile(artifactPath, localPath)
  }

  const model = await ctx.service.addModel({
    source: `s3://test-bucket/${filename}`,
    engine,
    licenseId: 'MIT'
  })
  await flushAutobases(ctx.service.base)

  return model
}

async function fitBlobFor(t, filename, buffer) {
  const dir = await createTempStorage(t)
  const filePath = path.join(dir, filename)
  await fs.writeFile(filePath, buffer)
  return fitBlobContent(filePath)
}

async function readBlob(service, binding) {
  const core = service.blobsStore.get({ key: binding.coreKey })
  await core.ready()
  const blobs = new Hyperblobs(core)
  await blobs.ready()

  const chunks = []
  for await (const chunk of blobs.createReadStream(binding)) {
    chunks.push(chunk)
  }
  await core.close()
  return Buffer.concat(chunks)
}

test('addModel stores a weightless description and points the record at it', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })
  ctx.t = t

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const fixture = buildGguf({ tensorCount: 4, dataBytes: 4096 })
    const model = await addLocalArtifact(ctx, {
      filename: 'model.gguf',
      buffer: fixture.buffer
    })

    const expected = await fitBlobFor(t, 'model.gguf', fixture.buffer)

    t.ok(model.fitBlobBinding, 'record carries a fit blob pointer')
    t.is(model.fitBlobBinding.byteLength, expected.length, 'pointer covers the description only')
    t.ok(
      model.fitBlobBinding.byteLength < model.blobBinding.byteLength,
      'the description is smaller than the artifact'
    )
    t.not(
      model.fitBlobBinding.sha256,
      model.blobBinding.sha256,
      'the description has its own checksum'
    )

    const stored = await readBlob(ctx.service, model.fitBlobBinding)
    t.alike(stored, expected, 'stored bytes are the weightless description')
    t.is(
      crypto.createHash('sha256').update(stored).digest('hex'),
      model.fitBlobBinding.sha256,
      'the recorded checksum matches what was stored'
    )

    const retrieved = await ctx.service.getModelByKey({
      path: model.path,
      source: model.source
    })
    t.alike(retrieved.fitBlobBinding, model.fitBlobBinding, 'pointer persisted')
  } finally {
    await cleanupService(ctx)
  }
})

test('every shard of a split model gets its own description', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })
  ctx.t = t

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const first = buildGguf({ tensorCount: 2, dataBytes: 512 })
    const second = buildGguf({ tensorCount: 9, dataBytes: 512 })

    const shard1 = await addLocalArtifact(ctx, {
      filename: 'model-00001-of-00002.gguf',
      buffer: first.buffer
    })
    const shard2 = await addLocalArtifact(ctx, {
      filename: 'model-00002-of-00002.gguf',
      buffer: second.buffer
    })

    const expectedFirst = await fitBlobFor(t, 'model-00001-of-00002.gguf', first.buffer)
    const expectedSecond = await fitBlobFor(t, 'model-00002-of-00002.gguf', second.buffer)

    t.ok(shard1.fitBlobBinding, 'first shard has a pointer')
    t.ok(shard2.fitBlobBinding, 'later shard has a pointer')
    t.is(shard1.fitBlobBinding.byteLength, expectedFirst.length)
    t.is(shard2.fitBlobBinding.byteLength, expectedSecond.length)
    t.not(
      shard1.fitBlobBinding.sha256,
      shard2.fitBlobBinding.sha256,
      'each shard is described separately'
    )
  } finally {
    await cleanupService(ctx)
  }
})

test('a safetensors artifact stores its JSON header', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })
  ctx.t = t

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const fixture = buildSafetensors()
    const model = await addLocalArtifact(ctx, {
      filename: 'vae.safetensors',
      buffer: fixture.buffer
    })

    t.ok(model.fitBlobBinding, 'record carries a fit blob pointer')
    t.is(model.fitBlobBinding.byteLength, fixture.metadataLength)

    const stored = await readBlob(ctx.service, model.fitBlobBinding)
    t.alike(stored, fixture.buffer.subarray(0, fixture.metadataLength))
  } finally {
    await cleanupService(ctx)
  }
})

test('a format with no separable metadata region is added without a pointer', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })
  ctx.t = t

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const model = await addLocalArtifact(ctx, {
      filename: 'ggml-tiny.bin',
      buffer: Buffer.alloc(256, 3)
    })

    t.absent(model.fitBlobBinding, 'no pointer for an unsupported format')
    t.ok(model.blobBinding, 'the artifact itself is still stored')
  } finally {
    await cleanupService(ctx)
  }
})

test('fillFitBlobs adds a pointer to records ingested without one', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })
  ctx.t = t

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const fixture = buildGguf({ tensorCount: 5, dataBytes: 2048 })
    const originalUpload = ctx.service._uploadFitBlob
    ctx.service._uploadFitBlob = () => null

    const model = await addLocalArtifact(ctx, {
      filename: 'legacy.gguf',
      buffer: fixture.buffer
    })
    t.absent(model.fitBlobBinding, 'ingested without a pointer')

    ctx.service._uploadFitBlob = originalUpload

    const planned = await ctx.service.fillFitBlobs({ dryRun: true })
    t.is(planned.selected, 1, 'dry run selects the record')
    t.is(planned.filled, 0, 'dry run writes nothing')
    t.alike(planned.paths, [model.path], 'dry run names what it would write')

    const report = await ctx.service.fillFitBlobs()
    await flushAutobases(ctx.service.base)

    t.is(report.filled, 1, 'one record filled')
    t.is(report.replaced, 0, 'nothing was replaced')
    t.is(report.downloaded, 0, 'the active core is read without a download')
    t.alike(report.skipped, [], 'nothing skipped')

    const retrieved = await ctx.service.getModelByKey({
      path: model.path,
      source: model.source
    })
    const expected = await fitBlobFor(t, 'legacy.gguf', fixture.buffer)

    t.ok(retrieved.fitBlobBinding, 'record now carries a pointer')
    t.is(retrieved.fitBlobBinding.byteLength, expected.length)
    t.alike(retrieved.blobBinding, model.blobBinding, 'the weights were not re-uploaded')

    const stored = await readBlob(ctx.service, retrieved.fitBlobBinding)
    t.alike(stored, expected)

    const second = await ctx.service.fillFitBlobs()
    t.is(second.selected, 0, 'a second run has nothing to do')

    const forced = await ctx.service.fillFitBlobs({ force: true })
    t.is(forced.selected, 1, 'force considers a record that already has a pointer')
    t.is(forced.unchanged, 1, 'an identical copy is left in place')
    t.is(forced.replaced, 0, 'no second blob was written')

    const afterForce = await ctx.service.getModelByKey({
      path: model.path,
      source: model.source
    })
    t.alike(afterForce.fitBlobBinding, retrieved.fitBlobBinding, 'the pointer is untouched')
  } finally {
    await cleanupService(ctx)
  }
})

test('fillFitBlobs replaces a pointer whose copy no longer matches', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })
  ctx.t = t

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const fixture = buildGguf({ tensorCount: 4, dataBytes: 1024 })
    const model = await addLocalArtifact(ctx, {
      filename: 'stale.gguf',
      buffer: fixture.buffer
    })
    t.ok(model.fitBlobBinding, 'ingested with a pointer')

    await ctx.service._appendOperation(DISPATCH_PUT_MODEL, {
      ...model,
      fitBlobBinding: { ...model.fitBlobBinding, sha256: 'stale'.padEnd(64, '0') }
    })
    await flushAutobases(ctx.service.base)

    const report = await ctx.service.fillFitBlobs({ force: true })
    await flushAutobases(ctx.service.base)

    t.is(report.replaced, 1, 'the stale pointer was replaced')
    t.is(report.filled, 0, 'it counts as a replacement, not a fill')
    t.is(report.unchanged, 0)

    const retrieved = await ctx.service.getModelByKey({
      path: model.path,
      source: model.source
    })
    t.is(
      retrieved.fitBlobBinding.sha256,
      model.fitBlobBinding.sha256,
      'the pointer describes the artifact again'
    )

    const stored = await readBlob(ctx.service, retrieved.fitBlobBinding)
    t.alike(stored, await fitBlobFor(t, 'stale.gguf', fixture.buffer))
  } finally {
    await cleanupService(ctx)
  }
})

test('fillFitBlobs leaves formats it cannot describe alone', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })
  ctx.t = t

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    await addLocalArtifact(ctx, {
      filename: 'ggml-tiny.bin',
      buffer: Buffer.alloc(256, 3)
    })

    const report = await ctx.service.fillFitBlobs({ force: true })
    t.is(report.selected, 0, 'an unsupported format is never selected, even under force')
    t.is(report.filled, 0)
  } finally {
    await cleanupService(ctx)
  }
})

test('fillFitBlobs honours filter and limit', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })
  ctx.t = t

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const originalUpload = ctx.service._uploadFitBlob
    ctx.service._uploadFitBlob = () => null

    for (const filename of ['qwen-a.gguf', 'qwen-b.gguf', 'flux-a.gguf']) {
      await addLocalArtifact(ctx, { filename, buffer: buildGguf().buffer })
    }

    ctx.service._uploadFitBlob = originalUpload

    const filtered = await ctx.service.fillFitBlobs({ filter: 'qwen', dryRun: true })
    t.is(filtered.selected, 2, 'filter narrows to the matching paths')

    const limited = await ctx.service.fillFitBlobs({ limit: 1, dryRun: true })
    t.is(limited.selected, 1, 'limit caps the batch')
  } finally {
    await cleanupService(ctx)
  }
})

test('fillFitBlobs reads the core the record names and writes to the active one', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })
  ctx.t = t

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const fixture = buildGguf({ tensorCount: 3, dataBytes: 1024 })
    const originalUpload = ctx.service._uploadFitBlob
    ctx.service._uploadFitBlob = () => null

    const model = await addLocalArtifact(ctx, {
      filename: 'rotated.gguf',
      buffer: fixture.buffer
    })

    ctx.service._uploadFitBlob = originalUpload
    ctx.service.activeBlobCoreLabel = 'models-2'

    const report = await ctx.service.fillFitBlobs()
    await flushAutobases(ctx.service.base)

    t.is(report.filled, 1, 'the weights are found through the key on the record')
    t.is(report.downloaded, 0, 'a local core is read rather than downloaded')

    const retrieved = await ctx.service.getModelByKey({
      path: model.path,
      source: model.source
    })
    const { core } = await ctx.service._getOrCreateBlobsCore('models-2')

    t.alike(retrieved.fitBlobBinding.coreKey, core.key, 'the pointer names the core written to')
    t.unlike(
      retrieved.fitBlobBinding.coreKey,
      retrieved.blobBinding.coreKey,
      'which is not the core holding the weights'
    )
    t.alike(
      await readBlob(ctx.service, retrieved.fitBlobBinding),
      await fitBlobFor(t, 'rotated.gguf', fixture.buffer)
    )
  } finally {
    await cleanupService(ctx)
  }
})

test('fillFitBlobs downloads the artifact when no local core holds it', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })
  ctx.t = t

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const fixture = buildGguf({ tensorCount: 4, dataBytes: 2048 })
    const originalUpload = ctx.service._uploadFitBlob
    ctx.service._uploadFitBlob = () => null

    const model = await addLocalArtifact(ctx, {
      filename: 'elsewhere.gguf',
      buffer: fixture.buffer
    })

    ctx.service._uploadFitBlob = originalUpload
    await ctx.service._appendOperation(DISPATCH_PUT_MODEL, {
      ...model,
      blobBinding: { ...model.blobBinding, coreKey: Buffer.alloc(32, 7) }
    })
    await flushAutobases(ctx.service.base)

    const report = await ctx.service.fillFitBlobs()
    await flushAutobases(ctx.service.base)

    t.is(report.filled, 1, 'the record is filled from its source')
    t.is(report.downloaded, 1, 'the fallback ran')

    const retrieved = await ctx.service.getModelByKey({
      path: model.path,
      source: model.source
    })
    t.alike(
      await readBlob(ctx.service, retrieved.fitBlobBinding),
      await fitBlobFor(t, 'elsewhere.gguf', fixture.buffer)
    )
    t.is(
      retrieved.blobBinding.byteLength,
      model.blobBinding.byteLength,
      'the weight binding is left as it was'
    )
  } finally {
    await cleanupService(ctx)
  }
})

test('fillFitBlobs skips a record whose source no longer matches the recorded hash', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })
  ctx.t = t

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const originalUpload = ctx.service._uploadFitBlob
    ctx.service._uploadFitBlob = () => null

    const model = await addLocalArtifact(ctx, {
      filename: 'mutated.gguf',
      buffer: buildGguf({ tensorCount: 2, dataBytes: 512 }).buffer
    })

    ctx.service._uploadFitBlob = originalUpload
    await ctx.service._appendOperation(DISPATCH_PUT_MODEL, {
      ...model,
      blobBinding: { ...model.blobBinding, coreKey: Buffer.alloc(32, 7) }
    })
    await flushAutobases(ctx.service.base)

    const replacement = buildGguf({ tensorCount: 9, dataBytes: 512 }).buffer
    ctx.service._downloadArtifact = async (sourceInfo, localPath) => {
      await fs.writeFile(localPath, replacement)
    }

    const report = await ctx.service.fillFitBlobs()

    t.is(report.filled, 0, 'nothing is published from bytes the record does not bind')
    t.is(report.skipped.length, 1)
    t.ok(report.skipped[0].reason.includes('the record binds'), report.skipped[0].reason)

    const retrieved = await ctx.service.getModelByKey({
      path: model.path,
      source: model.source
    })
    t.absent(retrieved.fitBlobBinding, 'no pointer is published')
  } finally {
    await cleanupService(ctx)
  }
})

test('fillFitBlobs falls back when the local blocks were cleared after mirroring', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })
  ctx.t = t

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const fixture = buildGguf({ tensorCount: 3, dataBytes: 4096 })
    const originalUpload = ctx.service._uploadFitBlob
    ctx.service._uploadFitBlob = () => null

    const model = await addLocalArtifact(ctx, {
      filename: 'cleared.gguf',
      buffer: fixture.buffer
    })

    ctx.service._uploadFitBlob = originalUpload
    const { core } = await ctx.service._getOrCreateBlobsCore(ctx.service.activeBlobCoreLabel)
    await core.clear(0, core.length)

    const started = Date.now()
    const report = await ctx.service.fillFitBlobs()
    await flushAutobases(ctx.service.base)

    t.is(report.filled, 1, 'the record is still filled')
    t.is(report.downloaded, 1, 'the source supplies the weights')
    t.ok(Date.now() - started < 20000, 'the read of the cleared core returns at once')

    const retrieved = await ctx.service.getModelByKey({
      path: model.path,
      source: model.source
    })
    t.alike(
      await readBlob(ctx.service, retrieved.fitBlobBinding),
      await fitBlobFor(t, 'cleared.gguf', fixture.buffer)
    )
  } finally {
    await cleanupService(ctx)
  }
})

test('fillFitBlobs reports a failed download and carries on with the batch', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const ctx = await createService(t, { swarmBootstrap: bootstrap })
  ctx.t = t

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const originalUpload = ctx.service._uploadFitBlob
    ctx.service._uploadFitBlob = () => null

    const unreachable = await addLocalArtifact(ctx, {
      filename: 'gone.gguf',
      buffer: buildGguf({ tensorCount: 2, dataBytes: 512 }).buffer
    })
    const reachable = await addLocalArtifact(ctx, {
      filename: 'present.gguf',
      buffer: buildGguf({ tensorCount: 3, dataBytes: 512 }).buffer
    })

    ctx.service._uploadFitBlob = originalUpload
    await ctx.service._appendOperation(DISPATCH_PUT_MODEL, {
      ...unreachable,
      blobBinding: { ...unreachable.blobBinding, coreKey: Buffer.alloc(32, 7) }
    })
    await flushAutobases(ctx.service.base)

    const copyArtifact = ctx.service._downloadArtifact
    ctx.service._downloadArtifact = async (sourceInfo, localPath) => {
      if (sourceInfo.path === unreachable.path) {
        throw Object.assign(new Error('403 Forbidden'), { statusCode: 403 })
      }
      await copyArtifact(sourceInfo, localPath)
    }

    const report = await ctx.service.fillFitBlobs()
    await flushAutobases(ctx.service.base)

    t.is(report.skipped.length, 1, 'the unreachable model is reported')
    t.is(report.skipped[0].path, unreachable.path)
    t.ok(report.skipped[0].reason.includes('403'), report.skipped[0].reason)
    t.is(report.filled, 1, 'the rest of the batch still runs')

    const stagingRoot = ctx.service.config.getTempStorage()
    const staged = await fs.readdir(stagingRoot).catch(() => [])
    t.alike(
      staged.filter((entry) => entry.startsWith('fit-')),
      [],
      'no staging directory is left behind'
    )

    const filled = await ctx.service.getModelByKey({
      path: reachable.path,
      source: reachable.source
    })
    t.ok(filled.fitBlobBinding, 'the reachable model got its pointer')
  } finally {
    await cleanupService(ctx)
  }
})

// The two writers replicate over a piped stream pair, so the case does not
// depend on peer discovery.
test('fillFitBlobs on a second indexer downloads what the first one ingested', async (t) => {
  const writer1 = await createService(t)
  await writer1.service.ready()
  await ensureIndexer(writer1.service)
  writer1.t = t

  const writer2 = await createService(t, { bootstrap: writer1.service.base.key })
  await writer2.service.ready()

  const stream1 = writer1.store.replicate(true)
  const stream2 = writer2.store.replicate(false)
  stream1.pipe(stream2).pipe(stream1)

  try {
    await writer1.service._appendOperation(DISPATCH_ADD_INDEXER, {
      key: writer2.service.base.local.key
    })
    await flushAutobases(writer1.service.base, writer2.service.base)
    await waitFor(async () => {
      await flushAutobases(writer1.service.base, writer2.service.base)
      return writer2.service.base.isIndexer === true
    }, 30000)

    const fixture = buildGguf({ tensorCount: 4, dataBytes: 2048 })
    const originalUpload = writer1.service._uploadFitBlob
    writer1.service._uploadFitBlob = () => null

    const model = await addLocalArtifact(writer1, {
      filename: 'ingested-elsewhere.gguf',
      buffer: fixture.buffer
    })
    writer1.service._uploadFitBlob = originalUpload

    await flushAutobases(writer1.service.base, writer2.service.base)
    await waitFor(async () => (await writer2.service.listModels()).length === 1, 30000)

    const artifactDir = await createTempStorage(t)
    const artifactPath = path.join(artifactDir, 'ingested-elsewhere.gguf')
    await fs.writeFile(artifactPath, fixture.buffer)
    writer2.service._downloadArtifact = async (sourceInfo, localPath) => {
      await fs.copyFile(artifactPath, localPath)
    }

    const report = await writer2.service.fillFitBlobs()
    await flushAutobases(writer2.service.base, writer1.service.base)

    t.is(report.filled, 1, 'the second indexer fills the record')
    t.is(report.downloaded, 1, 'the weights are in no core it holds')

    const retrieved = await writer2.service.getModelByKey({
      path: model.path,
      source: model.source
    })
    const { core } = await writer2.service._getOrCreateBlobsCore(
      writer2.service.activeBlobCoreLabel
    )
    t.alike(retrieved.fitBlobBinding.coreKey, core.key, 'the pointer names the filling indexer')
    t.unlike(retrieved.blobBinding.coreKey, core.key, 'the weights stay in the ingesting one')
    t.alike(
      await readBlob(writer2.service, retrieved.fitBlobBinding),
      await fitBlobFor(t, 'ingested-elsewhere.gguf', fixture.buffer)
    )
  } finally {
    await cleanupService(writer1)
    await cleanupService(writer2)
  }
})

async function waitForConnection(swarm1, swarm2) {
  await swarm1.flush()
  await swarm2.flush()
  // lunte-disable-next-line require-await
  await waitFor(async () => {
    return swarm1.connections.size > 0 && swarm2.connections.size > 0
  }, 10000)
}

async function flushAutobases(...bases) {
  for (let i = 0; i < 3; i++) {
    for (const base of bases) {
      await base.update()
    }
    for (const base of bases) {
      if (base.localWriter && base.localWriter.core.length > 0) {
        await base.ack()
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function ensureIndexer(service) {
  if (service.base.isIndexer) return
  await service._appendOperation(DISPATCH_ADD_INDEXER, { key: service.base.local.key })
  // lunte-disable-next-line require-await
  await waitFor(async () => service.base.isIndexer === true, 15000)
}
