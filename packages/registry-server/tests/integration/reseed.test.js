'use strict'

const test = require('brittle')
const path = require('path')
const fs = require('fs').promises
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Hyperblobs = require('hyperblobs')

const RegistryService = require('../../lib/registry-service')
const RegistryConfig = require('../../lib/config')
const { AUTOBASE_NAMESPACE, QVAC_MAIN_REGISTRY } = require('../../shared/constants')
const { createTempStorage, waitFor } = require('../helpers/test-utils')
const { createBlindPeerTestnet } = require('../helpers/blind-peer-testnet')

const DISPATCH_ADD_INDEXER = `@${QVAC_MAIN_REGISTRY}/add-indexer`

const noopLogger = {
  info () {},
  debug () {},
  error () {},
  warn () {}
}

test('blob cores are reseeded to blind peers and downloadable via swarm', async (t) => {
  const { bootstrap, blindPeerKeys, peers: blindPeers } = await createBlindPeerTestnet(t, { peers: 1 })
  const ctx = await createService(t, { swarmBootstrap: bootstrap, blindPeerKeys })

  const dhtKey = ctx.swarm.dht.defaultKeyPair.publicKey
  for (const instance of blindPeers) {
    instance.peer.addTrustedPubKey(dhtKey)
  }

  try {
    await ctx.service.ready()
    await ensureIndexer(ctx.service)

    const tempDir = await createTempStorage(t)
    const artifactPath = path.join(tempDir, 'model.bin')
    const modelPayload = Buffer.from('blind-peer-test-payload')
    await fs.writeFile(artifactPath, modelPayload)

    ctx.service._downloadArtifact = async (sourceInfo, localPath) => {
      await fs.copyFile(artifactPath, localPath)
      return localPath
    }

    const model = await ctx.service.addModel({
      source: 's3://test-bucket/model.bin',
      engine: '@test/blind-peer',
      licenseId: 'MIT'
    })

    const coreKey = Buffer.isBuffer(model.blobBinding.coreKey)
      ? model.blobBinding.coreKey
      : Buffer.from(model.blobBinding.coreKey, 'hex')

    // Connect via registry's base discovery key (which IS announced)
    // Blob cores replicate through the registry -> blind peer connection
    const baseDiscoveryKey = ctx.service.base.discoveryKey
    const remote = await createRemoteClient(t, bootstrap, coreKey, baseDiscoveryKey)

    const remoteBlobs = new Hyperblobs(remote.core)
    await remoteBlobs.ready()

    const replicated = await waitFor(async () => {
      try {
        const buf = await remoteBlobs.get({
          blockOffset: model.blobBinding.blockOffset,
          blockLength: model.blobBinding.blockLength,
          byteOffset: model.blobBinding.byteOffset,
          byteLength: model.blobBinding.byteLength
        })
        return buf.equals(modelPayload)
      } catch {
        return false
      }
    }, 20000, 500)

    t.ok(replicated, 'blob data downloaded via registry connection to blind peer')

    await remote.cleanup()
  } finally {
    await cleanupService(ctx)
  }
})

async function createService (t, { storage, bootstrap, swarmBootstrap, blindPeerKeys } = {}) {
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
      blindPeerKeys: blindPeerKeys || [],
      skipStorageCheck: true
    }
  )

  return { service, store, swarm, storage: basePath }
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

async function createRemoteClient (t, bootstrap, coreKey, baseDiscoveryKey) {
  const storage = await createTempStorage(t)
  const store = new Corestore(storage)
  await store.ready()
  const swarm = new Hyperswarm({ bootstrap })

  let connected = false
  swarm.on('connection', conn => {
    connected = true
    store.replicate(conn)
  })

  // Join on registry's base discovery key (not blob core key)
  // Blob cores replicate through the registry -> blind peer connection
  const topic = swarm.join(baseDiscoveryKey, { client: true, server: false })
  await topic.flushed()

  // Wait for connection to be established
  await waitFor(() => connected, 10000, 100)

  // Now get the blob core - it will replicate over the established connection
  const core = store.get({ key: coreKey })
  await core.ready()
  await core.update({ wait: true })

  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    await swarm.destroy().catch(() => {})
    await store.close().catch(() => {})
  }

  t.teardown(cleanup)

  return { core, cleanup }
}
