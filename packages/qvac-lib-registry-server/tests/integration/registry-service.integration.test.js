'use strict'

const test = require('brittle')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const createTestnet = require('hyperdht/testnet')
const fs = require('fs').promises
const path = require('path')

const RegistryService = require('../../lib/registry-service')
const RegistryConfig = require('../../lib/config')
const { AUTOBASE_NAMESPACE, QVAC_MAIN_REGISTRY } = require('../../shared/constants')
const { createTempStorage, waitFor } = require('../helpers/test-utils')

const DISPATCH_ADD_INDEXER = `@${QVAC_MAIN_REGISTRY}/add-indexer`
const DISPATCH_PUT_MODEL = `@${QVAC_MAIN_REGISTRY}/put-model`

const noopLogger = {
  info () {},
  debug () {},
  error () {},
  warn () {}
}

// Tiny model from HuggingFace (~1MB) for integration testing
const TEST_MODEL_URL = 'https://huggingface.co/klosax/tinyllamas-stories-gguf/resolve/main/tinyllamas-stories-260k-f32.gguf'

async function createService (t, { storage, bootstrap, swarmBootstrap } = {}) {
  const basePath = storage || await createTempStorage(t)
  const store = new Corestore(basePath)
  await store.ready()

  const swarm = new Hyperswarm({ bootstrap: swarmBootstrap || [] })
  const config = new RegistryConfig({ logger: noopLogger })

  const service = new RegistryService(
    store.namespace(AUTOBASE_NAMESPACE),
    swarm,
    config,
    {
      logger: noopLogger,
      ackInterval: 5,
      autobaseBootstrap: bootstrap || null,
      skipStorageCheck: true
    }
  )

  return { service, store, swarm, config, storage: basePath }
}

async function cleanupService ({ service, store, swarm }) {
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

    await writer1.service._appendOperation(DISPATCH_ADD_INDEXER, { key: writer2.service.base.local.key })
    await flushAutobases(writer1.service.base, writer2.service.base)
    await waitFor(async () => writer2.service.base.isIndexer === true, 15000)

    await writer1.service._appendOperation(DISPATCH_ADD_INDEXER, { key: writer3.service.base.local.key })
    await flushAutobases(writer1.service.base, writer3.service.base)
    await waitFor(async () => writer3.service.base.isIndexer === true, 15000)

    // Writer1 adds a model - using real HuggingFace URL
    await writer1.service.addModel({ source: TEST_MODEL_URL, engine: '@test/tinyllamas', licenseId: 'MIT' })

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
    t.ok(allLicenses.some(l => l.spdxId === 'MIT'), 'MIT license in list')
  } finally {
    await cleanupService(ctx)
  }
})

test('Model with licenseId can fetch license info', async (t) => {
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
    t.ok(listResult.some(l => l.spdxId === 'GPL-3.0'), 'GPL-3.0 license in list')
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
    const model2 = await ctx.service.addModel({
      source: 's3://test-bucket/skip-test.bin',
      engine: '@test/engine',
      licenseId: 'MIT'
    }, { skipExisting: true })
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

    const afterDeprecate = await ctx.service.getModelByKey({ path: model.path, source: model.source })
    t.is(afterDeprecate.deprecated, true, 'model is deprecated')
    t.ok(afterDeprecate.deprecatedAt, 'deprecatedAt is set')
    t.ok(afterDeprecate.replacedBy, 'replacedBy is set')
    t.ok(afterDeprecate.deprecationReason, 'deprecationReason is set')

    // Now undeprecate via the RPC handler logic (simulated)
    const deprecatedModel = await ctx.service.getModelByKey({ path: model.path, source: model.source })
    const undeprecated = {
      ...deprecatedModel,
      deprecated: false,
      deprecatedAt: '',
      replacedBy: '',
      deprecationReason: ''
    }
    await ctx.service._appendOperation(DISPATCH_PUT_MODEL, undeprecated)
    await flushAutobases(ctx.service.base)

    const afterUndeprecate = await ctx.service.getModelByKey({ path: model.path, source: model.source })
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

async function waitForConnection (swarm1, swarm2) {
  await swarm1.flush()
  await swarm2.flush()
  await waitFor(async () => {
    return swarm1.connections.size > 0 && swarm2.connections.size > 0
  }, 10000)
}

async function flushAutobases (...bases) {
  for (let i = 0; i < 3; i++) {
    for (const base of bases) {
      await base.update()
    }
    for (const base of bases) {
      if (base.localWriter && base.localWriter.core.length > 0) {
        await base.ack()
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

async function ensureIndexer (service) {
  if (service.base.isIndexer) return
  await service._appendOperation(DISPATCH_ADD_INDEXER, { key: service.base.local.key })
  await waitFor(async () => service.base.isIndexer === true, 15000)
}
