'use strict'

const test = require('brittle')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const createTestnet = require('hyperdht/testnet')

const RegistryService = require('../../lib/registry-service')
const RegistryConfig = require('../../lib/config')
const { AUTOBASE_NAMESPACE, QVAC_MAIN_REGISTRY } = require('../../shared/constants')
const { createTempStorage, waitFor } = require('../helpers/test-utils')

const DISPATCH_ADD_INDEXER = `@${QVAC_MAIN_REGISTRY}/add-indexer`
const DISPATCH_REMOVE_INDEXER = `@${QVAC_MAIN_REGISTRY}/remove-indexer`

const noopLogger = {
  info () {},
  debug () {},
  error () {},
  warn () {}
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
      try {
        if (base.localWriter && base.localWriter.core.length > 0) {
          await base.ack()
        }
      } catch (_) {
        // Writer may have been removed from quorum
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

test('Add indexer to quorum and verify data replication', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const writer1 = await createService(t, { swarmBootstrap: bootstrap })
  await writer1.service.ready()
  await ensureIndexer(writer1.service)

  const writer2 = await createService(t, {
    bootstrap: writer1.service.base.key,
    swarmBootstrap: bootstrap
  })
  await writer2.service.ready()

  try {
    await waitForConnection(writer1.swarm, writer2.swarm)

    await writer1.service._appendOperation(DISPATCH_ADD_INDEXER, { key: writer2.service.base.local.key })
    await flushAutobases(writer1.service.base, writer2.service.base)
    await waitFor(async () => writer2.service.base.isIndexer === true, 15000)

    t.ok(writer1.service.base.isIndexer, 'writer1 is indexer')
    t.ok(writer2.service.base.isIndexer, 'writer2 is indexer')

    await writer1.service.putLicense({
      spdxId: 'MIT',
      name: 'MIT License',
      url: 'https://opensource.org/licenses/MIT',
      text: 'MIT License text'
    })
    await flushAutobases(writer1.service.base, writer2.service.base)

    await waitFor(async () => {
      const l = await writer2.service.getLicenseByKey({ spdxId: 'MIT' })
      return !!l
    }, 15000)

    const license1 = await writer1.service.getLicenseByKey({ spdxId: 'MIT' })
    const license2 = await writer2.service.getLicenseByKey({ spdxId: 'MIT' })

    t.ok(license1, 'writer1 sees license')
    t.ok(license2, 'writer2 sees license after replication')
    t.is(license2.spdxId, 'MIT', 'replicated data matches')
  } finally {
    await cleanupService(writer2)
    await cleanupService(writer1)
  }
})

test('Remove indexer from quorum preserves data and remaining indexer', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const writer1 = await createService(t, { swarmBootstrap: bootstrap })
  await writer1.service.ready()
  await ensureIndexer(writer1.service)

  const writer2 = await createService(t, {
    bootstrap: writer1.service.base.key,
    swarmBootstrap: bootstrap
  })
  await writer2.service.ready()

  try {
    await waitForConnection(writer1.swarm, writer2.swarm)

    // Build 2-indexer quorum
    await writer1.service._appendOperation(DISPATCH_ADD_INDEXER, { key: writer2.service.base.local.key })
    await flushAutobases(writer1.service.base, writer2.service.base)
    await waitFor(async () => writer2.service.base.isIndexer === true, 15000)

    // Seed data before removal
    await writer1.service.putLicense({
      spdxId: 'MIT',
      name: 'MIT License',
      url: 'https://opensource.org/licenses/MIT',
      text: 'MIT License text'
    })
    await flushAutobases(writer1.service.base, writer2.service.base)
    await waitFor(async () => {
      const l = await writer2.service.getLicenseByKey({ spdxId: 'MIT' })
      return !!l
    }, 15000)

    // Remove writer2 from quorum
    await writer1.service._appendOperation(DISPATCH_REMOVE_INDEXER, { key: writer2.service.base.local.key })
    await flushAutobases(writer1.service.base, writer2.service.base)
    await waitFor(async () => writer2.service.base.isIndexer === false, 15000)

    t.ok(writer1.service.base.isIndexer, 'writer1 still indexer after removal')
    t.is(writer2.service.base.isIndexer, false, 'writer2 no longer indexer')

    // Remaining indexer can still write
    await writer1.service.putLicense({
      spdxId: 'Apache-2.0',
      name: 'Apache License 2.0',
      url: 'https://opensource.org/licenses/Apache-2.0',
      text: 'Apache License text'
    })
    await flushAutobases(writer1.service.base)

    const apache = await writer1.service.getLicenseByKey({ spdxId: 'Apache-2.0' })
    t.ok(apache, 'remaining indexer can write after removal')

    // Data written before removal is still accessible
    const mit = await writer1.service.getLicenseByKey({ spdxId: 'MIT' })
    t.ok(mit, 'pre-removal data preserved')
  } finally {
    await cleanupService(writer2)
    await cleanupService(writer1)
  }
})

test('Full indexer lifecycle: add, remove, re-add', async (t) => {
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

    // Phase 1: Build 3-indexer quorum
    await writer1.service._appendOperation(DISPATCH_ADD_INDEXER, { key: writer2.service.base.local.key })
    await flushAutobases(writer1.service.base, writer2.service.base)
    await waitFor(async () => writer2.service.base.isIndexer === true, 15000)

    await writer1.service._appendOperation(DISPATCH_ADD_INDEXER, { key: writer3.service.base.local.key })
    await flushAutobases(writer1.service.base, writer2.service.base, writer3.service.base)
    await waitFor(async () => writer3.service.base.isIndexer === true, 15000)

    t.ok(writer1.service.base.isIndexer, 'phase1: writer1 is indexer')
    t.ok(writer2.service.base.isIndexer, 'phase1: writer2 is indexer')
    t.ok(writer3.service.base.isIndexer, 'phase1: writer3 is indexer')

    // Seed data with full quorum
    await writer1.service.putLicense({
      spdxId: 'MIT',
      name: 'MIT License',
      url: 'https://opensource.org/licenses/MIT',
      text: 'MIT License text'
    })
    await flushAutobases(writer1.service.base, writer2.service.base, writer3.service.base)

    await waitFor(async () => {
      const [a, b, c] = await Promise.all([
        writer1.service.getLicenseByKey({ spdxId: 'MIT' }),
        writer2.service.getLicenseByKey({ spdxId: 'MIT' }),
        writer3.service.getLicenseByKey({ spdxId: 'MIT' })
      ])
      return !!a && !!b && !!c
    }, 15000)

    // Phase 2: Remove writer3 from quorum
    await writer1.service._appendOperation(DISPATCH_REMOVE_INDEXER, { key: writer3.service.base.local.key })
    await flushAutobases(writer1.service.base, writer2.service.base, writer3.service.base)
    await waitFor(async () => writer3.service.base.isIndexer === false, 15000)

    t.ok(writer1.service.base.isIndexer, 'phase2: writer1 still indexer')
    t.ok(writer2.service.base.isIndexer, 'phase2: writer2 still indexer')
    t.is(writer3.service.base.isIndexer, false, 'phase2: writer3 removed')

    // Verify 2-indexer quorum still works
    await writer1.service.putLicense({
      spdxId: 'Apache-2.0',
      name: 'Apache License 2.0',
      url: 'https://opensource.org/licenses/Apache-2.0',
      text: 'Apache License text'
    })
    await flushAutobases(writer1.service.base, writer2.service.base)

    await waitFor(async () => {
      const l = await writer2.service.getLicenseByKey({ spdxId: 'Apache-2.0' })
      return !!l
    }, 15000)

    t.ok(await writer2.service.getLicenseByKey({ spdxId: 'Apache-2.0' }), 'phase2: 2-indexer quorum writes')

    // Phase 3: Re-add writer3 as indexer
    await writer1.service._appendOperation(DISPATCH_ADD_INDEXER, { key: writer3.service.base.local.key })
    await flushAutobases(writer1.service.base, writer2.service.base, writer3.service.base)
    await waitFor(async () => writer3.service.base.isIndexer === true, 15000)

    t.ok(writer3.service.base.isIndexer, 'phase3: writer3 re-added as indexer')

    // Verify restored quorum sees all data
    await writer1.service.putLicense({
      spdxId: 'BSD-3-Clause',
      name: 'BSD 3-Clause',
      url: 'https://opensource.org/licenses/BSD-3-Clause',
      text: 'BSD 3-Clause text'
    })
    await flushAutobases(writer1.service.base, writer2.service.base, writer3.service.base)

    await waitFor(async () => {
      const l = await writer3.service.getLicenseByKey({ spdxId: 'BSD-3-Clause' })
      return !!l
    }, 15000)

    const bsd = await writer3.service.getLicenseByKey({ spdxId: 'BSD-3-Clause' })
    t.ok(bsd, 'phase3: restored quorum replicates new data')

    const apache = await writer3.service.getLicenseByKey({ spdxId: 'Apache-2.0' })
    t.ok(apache, 'phase3: data written during removal is accessible')

    const mit = await writer3.service.getLicenseByKey({ spdxId: 'MIT' })
    t.ok(mit, 'phase3: original data preserved through full lifecycle')
  } finally {
    await cleanupService(writer3)
    await cleanupService(writer2)
    await cleanupService(writer1)
  }
})
