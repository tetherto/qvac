'use strict'

const test = require('brittle')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const createTestnet = require('hyperdht/testnet')
const { RegistryDatabase } = require('@qvac/registry-schema')
const IdEnc = require('hypercore-id-encoding')
const fs = require('fs')
const path = require('path')

const RegistryService = require('../../lib/registry-service')
const RegistryConfig = require('../../lib/config')
const QVACRegistryClient = require('../../client/lib/client')
const { AUTOBASE_NAMESPACE, QVAC_MAIN_REGISTRY } = require('../../shared/constants')
const { createTempStorage, waitFor } = require('../helpers/test-utils')

const DISPATCH_ADD_INDEXER = `@${QVAC_MAIN_REGISTRY}/add-indexer`

const noopLogger = {
  info () {},
  debug () {},
  error () {},
  warn () {}
}

function createTestPayload (size) {
  const buf = Buffer.alloc(size)
  for (let i = 0; i < size; i++) {
    buf[i] = i % 256
  }
  return buf
}

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

async function ensureIndexer (service) {
  if (service.base.isIndexer) return
  await service._appendOperation(DISPATCH_ADD_INDEXER, { key: service.base.local.key })
  await waitFor(async () => service.base.isIndexer === true, 15000)
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

async function setupRegistryWithModel (t, bootstrap) {
  const ctx = await createService(t, { swarmBootstrap: bootstrap })
  await ctx.service.ready()
  await ensureIndexer(ctx.service)

  const testPayload = createTestPayload(256 * 1024)

  const tempDir = await createTempStorage(t)
  const artifactPath = path.join(tempDir, 'test-model.bin')
  fs.writeFileSync(artifactPath, testPayload)

  ctx.service._downloadArtifact = async (sourceInfo, localPath) => {
    await fs.promises.copyFile(artifactPath, localPath)
    return localPath
  }

  const model = await ctx.service.addModel({
    source: 's3://test-bucket/test-model.bin',
    engine: '@test/resume-engine',
    licenseId: 'MIT'
  })
  await flushAutobases(ctx.service.base)

  return { ctx, model, testPayload }
}

async function createTestClient (t, serviceCtx, bootstrap, storage) {
  const registryCoreKey = serviceCtx.service.registryCoreKey
  const clientStorage = storage || await createTempStorage(t)
  const corestore = new Corestore(clientStorage)
  await corestore.ready()

  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (conn) => {
    corestore.replicate(conn)
  })

  const viewKey = IdEnc.decode(registryCoreKey)
  const viewCore = corestore.get({ key: viewKey })
  await viewCore.ready()

  swarm.join(viewCore.discoveryKey, { client: true, server: false })
  swarm.join(serviceCtx.service.base.discoveryKey, { client: true, server: false })
  await swarm.flush()

  await waitFor(async () => {
    await viewCore.update({ wait: false })
    return viewCore.length > 0
  }, 15000)

  const db = new RegistryDatabase(viewCore, { extension: false })
  await db.ready()

  const proto = QVACRegistryClient.prototype
  const client = {
    corestore,
    db,
    logger: noopLogger,

    _validateString: proto._validateString,
    _checkBlobProgress: proto._checkBlobProgress,
    _getBlobsCore: proto._getBlobsCore.bind({ corestore, logger: noopLogger }),

    async ready () {},

    async getModel (modelPath, source) {
      const result = await db.getModel(modelPath, source)
      return result ?? null
    },

    async downloadModel (modelPath, source, options = {}) {
      proto._validateString(modelPath, 'path')
      proto._validateString(source, 'source')

      const model = await this.getModel(modelPath, source)
      if (!model) throw new Error('Model not found')
      if (!model.blobBinding || !model.blobBinding.coreKey) throw new Error('Model missing blob binding')

      const { core, blobs } = await this._getBlobsCore(model.blobBinding.coreKey)

      swarm.join(core.discoveryKey, { client: true, server: false })
      await swarm.flush()
      await core.update({ wait: true })

      const totalSize = model.blobBinding.byteLength

      if (options.outputFile) {
        await proto._streamBlobToFile.call(
          { logger: noopLogger, _checkBlobProgress: proto._checkBlobProgress },
          blobs, core, model.blobBinding, options.outputFile, options
        )
        await blobs.close()
        await core.close()
        return { model, artifact: { path: options.outputFile, totalSize } }
      }

      const stream = blobs.createReadStream(model.blobBinding, {
        wait: true,
        timeout: options.timeout || 30000
      })
      stream.on('close', async () => {
        await blobs.close().catch(() => {})
        await core.close().catch(() => {})
      })
      return { model, artifact: { stream, totalSize } }
    }
  }

  return { client, swarm, corestore, storage: clientStorage }
}

async function cleanupTestClient (ctx) {
  if (ctx.client && ctx.client.db) {
    await ctx.client.db.close().catch(() => {})
  }
  if (ctx.swarm) {
    await ctx.swarm.destroy().catch(() => {})
  }
  if (ctx.corestore) {
    await ctx.corestore.close().catch(() => {})
  }
}

test('downloadModel with outputFile writes complete file', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await createTestnet(3, t.teardown)
  const { ctx, model, testPayload } = await setupRegistryWithModel(t, bootstrap)

  const clientCtx = await createTestClient(t, ctx, bootstrap)
  const outputFile = path.join(await createTempStorage(t), 'output.bin')

  try {
    let progressCalls = 0
    await clientCtx.client.downloadModel(model.path, model.source, {
      outputFile,
      timeout: 30000,
      onProgress: () => { progressCalls++ }
    })

    t.ok(fs.existsSync(outputFile), 'output file created')
    const downloaded = fs.readFileSync(outputFile)
    t.is(downloaded.length, testPayload.length, 'file size matches')
    t.ok(downloaded.equals(testPayload), 'file content matches')
    t.ok(progressCalls > 0, 'onProgress called')
  } finally {
    await cleanupTestClient(clientCtx)
    await cleanupService(ctx)
  }
})

test('download cancel and resume produces correct file', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await createTestnet(3, t.teardown)
  const { ctx, model, testPayload } = await setupRegistryWithModel(t, bootstrap)

  const clientStorage = await createTempStorage(t)
  const outputFile = path.join(await createTempStorage(t), 'output.bin')

  // Phase 1: start download, cancel after first progress
  const clientCtx1 = await createTestClient(t, ctx, bootstrap, clientStorage)

  try {
    const ac = new AbortController()

    try {
      await clientCtx1.client.downloadModel(model.path, model.source, {
        outputFile,
        timeout: 30000,
        signal: ac.signal,
        onProgress: (progress) => {
          if (progress.downloaded > 0 && !ac.signal.aborted) {
            ac.abort()
          }
        }
      })
      t.fail('should have thrown on cancel')
    } catch (err) {
      t.is(err.message, 'Download cancelled', 'throws cancel error')
    }

    await cleanupTestClient(clientCtx1)
  } catch (err) {
    await cleanupTestClient(clientCtx1)
    throw err
  }

  // Phase 2: resume with new client on same persistent storage
  const clientCtx2 = await createTestClient(t, ctx, bootstrap, clientStorage)

  try {
    await clientCtx2.client.downloadModel(model.path, model.source, {
      outputFile,
      timeout: 30000
    })

    t.ok(fs.existsSync(outputFile), 'output file exists after resume')
    const downloaded = fs.readFileSync(outputFile)
    t.is(downloaded.length, testPayload.length, 'resumed file has correct size')
    t.ok(downloaded.equals(testPayload), 'resumed file has correct content')
  } finally {
    await cleanupTestClient(clientCtx2)
    await cleanupService(ctx)
  }
})

test('onProgress reports initial cached bytes on resume', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await createTestnet(3, t.teardown)
  const { ctx, model, testPayload } = await setupRegistryWithModel(t, bootstrap)

  const clientStorage = await createTempStorage(t)
  const outputFile = path.join(await createTempStorage(t), 'output.bin')

  // Phase 1: partial download
  const clientCtx1 = await createTestClient(t, ctx, bootstrap, clientStorage)

  try {
    const ac = new AbortController()

    try {
      await clientCtx1.client.downloadModel(model.path, model.source, {
        outputFile,
        timeout: 30000,
        signal: ac.signal,
        onProgress: (progress) => {
          if (progress.downloaded > 0 && !ac.signal.aborted) {
            ac.abort()
          }
        }
      })
    } catch {}

    await cleanupTestClient(clientCtx1)
  } catch (err) {
    await cleanupTestClient(clientCtx1)
    throw err
  }

  // Phase 2: resume and verify first progress event reflects cached state
  const clientCtx2 = await createTestClient(t, ctx, bootstrap, clientStorage)

  try {
    const progressEvents = []

    await clientCtx2.client.downloadModel(model.path, model.source, {
      outputFile,
      timeout: 30000,
      onProgress: (progress) => {
        progressEvents.push({ ...progress })
      }
    })

    t.ok(progressEvents.length > 0, 'received progress events')

    const firstEvent = progressEvents[0]
    t.ok(firstEvent.downloaded > 0, 'first progress event shows cached bytes')
    t.ok(firstEvent.total === testPayload.length, 'total matches expected size')
  } finally {
    await cleanupTestClient(clientCtx2)
    await cleanupService(ctx)
  }
})
