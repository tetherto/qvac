'use strict'

const test = require('brittle')
const Corestore = require('corestore')
const Hyperblobs = require('hyperblobs')
const EventEmitter = require('events')
const fs = require('fs').promises
const os = require('os')
const path = require('path')

const RegistryService = require('../../lib/registry-service')
const RegistryConfig = require('../../lib/config')
const { AUTOBASE_NAMESPACE, QVAC_MAIN_REGISTRY } = require('../../shared/constants')
const { waitFor } = require('../helpers/test-utils')

const DISPATCH_ADD_INDEXER = `@${QVAC_MAIN_REGISTRY}/add-indexer`

const noopLogger = {
  info() {},
  debug() {},
  error() {},
  warn() {}
}

test('blob core generation rotates new writes while historical blobs remain readable', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qvac-blob-core-rotation-'))
  const storage = path.join(tempRoot, 'registry')
  const fixtures = path.join(tempRoot, 'fixtures')
  await fs.mkdir(fixtures)
  const legacyPayload = Buffer.from('legacy-generation-payload')
  const rotatedPayload = Buffer.from('rotated-generation-payload')
  const legacyFixture = path.join(fixtures, 'legacy.bin')
  const rotatedFixture = path.join(fixtures, 'rotated.bin')
  await fs.writeFile(legacyFixture, legacyPayload)
  await fs.writeFile(rotatedFixture, rotatedPayload)

  const legacy = await createService({ storage, blobCoreGeneration: '' })
  let rotated = null

  try {
    await legacy.service.ready()
    await ensureIndexer(legacy.service)
    stubDownload(legacy.service, legacyFixture)

    const legacyModel = await legacy.service.addModel({
      source: 's3://test-bucket/legacy.bin',
      engine: '@test/engine',
      licenseId: 'MIT'
    })
    await flushAutobase(legacy.service.base)

    const legacyBinding = legacyModel.blobBinding
    const autobaseBootstrap = Buffer.from(legacy.service.base.key)

    t.is(legacy.service.activeBlobCoreLabel, 'models')
    t.ok(
      legacy.service.blobsCores.get('models').core.key.equals(legacyBinding.coreKey),
      'legacy model points to the default models core'
    )

    await cleanupService(legacy)

    rotated = await createService({
      storage,
      bootstrap: autobaseBootstrap,
      blobCoreGeneration: '2026-09-10'
    })
    await rotated.service.ready()
    await ensureIndexer(rotated.service)
    stubDownload(rotated.service, rotatedFixture)

    const rotatedModel = await rotated.service.addModel({
      source: 's3://test-bucket/rotated.bin',
      engine: '@test/engine',
      licenseId: 'MIT'
    })
    await flushAutobase(rotated.service.base)

    t.is(rotated.service.activeBlobCoreLabel, 'models-2026-09-10')
    t.not(
      legacyBinding.coreKey.toString('hex'),
      rotatedModel.blobBinding.coreKey.toString('hex'),
      'rotation creates a distinct writable core'
    )

    const persistedLegacy = await rotated.service.getModelByKey({
      path: legacyModel.path,
      source: legacyModel.source
    })
    const persistedRotated = await rotated.service.getModelByKey({
      path: rotatedModel.path,
      source: rotatedModel.source
    })

    t.alike(persistedLegacy.blobBinding, legacyBinding, 'historical blobBinding is unchanged')
    t.ok((await readBlob(rotated.service, persistedLegacy.blobBinding)).equals(legacyPayload))
    t.ok((await readBlob(rotated.service, persistedRotated.blobBinding)).equals(rotatedPayload))
  } finally {
    await cleanupService(legacy)
    if (rotated) await cleanupService(rotated)
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

async function createService({ storage, bootstrap = null, blobCoreGeneration }) {
  const store = new Corestore(storage)
  await store.ready()

  const swarm = createSwarm()
  const config = new RegistryConfig({ logger: noopLogger })
  const service = new RegistryService(store.namespace(AUTOBASE_NAMESPACE), swarm, config, {
    logger: noopLogger,
    ackInterval: 5,
    autobaseBootstrap: bootstrap,
    blobCoreGeneration,
    skipStorageCheck: true
  })

  return { service, store, swarm }
}

function createSwarm() {
  const swarm = new EventEmitter()
  swarm.keyPair = { publicKey: Buffer.alloc(32) }
  swarm.join = () => {}
  swarm.leave = () => {}
  swarm.destroy = () => Promise.resolve()
  return swarm
}

function stubDownload(service, fixture) {
  service._downloadArtifact = async (sourceInfo, localPath) => {
    await fs.copyFile(fixture, localPath)
    return localPath
  }
}

async function readBlob(service, binding) {
  const core = service.blobsStore.get({ key: binding.coreKey })
  await core.ready()
  const blobs = new Hyperblobs(core)
  await blobs.ready()

  try {
    return await blobs.get(binding)
  } finally {
    await blobs.close()
    await core.close()
  }
}

async function ensureIndexer(service) {
  if (service.base.isIndexer) return
  await service._appendOperation(DISPATCH_ADD_INDEXER, { key: service.base.local.key })
  // lunte-disable-next-line require-await
  await waitFor(async () => service.base.isIndexer === true, 15000)
}

async function flushAutobase(base) {
  for (let i = 0; i < 3; i++) {
    await base.update()
    if (base.localWriter && base.localWriter.core.length > 0) await base.ack()
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function cleanupService({ service, store, swarm }) {
  if (service?.opened) await service.close().catch(() => {})
  if (swarm) await swarm.destroy().catch(() => {})
  if (store) await store.close().catch(() => {})
}
