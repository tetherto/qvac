'use strict'

const test = require('brittle')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const DHT = require('hyperdht')
const ProtomuxRPC = require('protomux-rpc')
const cenc = require('compact-encoding')
const createTestnet = require('hyperdht/testnet')
const crypto = require('crypto')

const RegistryService = require('../../lib/registry-service')
const RegistryConfig = require('../../lib/config')
const { AUTOBASE_NAMESPACE } = require('../../shared/constants')
const { createTempStorage } = require('../helpers/test-utils')

const noopLogger = {
  info() {},
  debug() {},
  error() {},
  warn() {}
}

test('capacity RPC returns only available bytes to an authorized writer', async (t) => {
  t.timeout(60000)
  const writerKeyPair = DHT.keyPair()
  const ctx = await createCapacityService(t, writerKeyPair.publicKey)
  const client = await connectRpcClient(ctx.bootstrap, writerKeyPair, ctx.service.base.key)

  try {
    const result = await client.rpc.request('get-storage-capacity', {}, { timeout: 10000 })

    t.alike(Object.keys(result), ['availableBytes'])
    t.ok(/^\d+$/.test(result.availableBytes), 'available bytes is an exact decimal string')
  } finally {
    await client.cleanup()
    await ctx.cleanup()
  }
})

test('capacity RPC rejects a writer outside the allowlist', async (t) => {
  t.timeout(60000)
  const allowedWriter = DHT.keyPair()
  const unauthorizedWriter = DHT.keyPair()
  const ctx = await createCapacityService(t, allowedWriter.publicKey)
  const client = await connectRpcClient(ctx.bootstrap, unauthorizedWriter, ctx.service.base.key)

  try {
    await client.rpc.request('get-storage-capacity', {}, { timeout: 10000 })
    t.fail('Expected unauthorized capacity request to fail')
  } catch (err) {
    t.is(err.cause?.code, 'ERR_WRITER_UNAUTHORIZED')
  } finally {
    await client.cleanup()
    await ctx.cleanup()
  }
})

async function createCapacityService(t, allowedWriterKey) {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const storagePath = await createTempStorage(t)
  const store = new Corestore(storagePath)
  await store.ready()

  const swarm = new Hyperswarm({ bootstrap })
  const config = new RegistryConfig({ logger: noopLogger })
  config.getAllowedWriterKeys = () => new Set([allowedWriterKey.toString('hex')])

  const service = new RegistryService(store.namespace(AUTOBASE_NAMESPACE), swarm, config, {
    logger: noopLogger,
    storagePath,
    ackInterval: 5,
    skipStorageCheck: true
  })
  await service.ready()
  await swarm.flush()

  return {
    bootstrap,
    store,
    swarm,
    service,
    async cleanup() {
      if (service.opened) await service.close().catch(() => {})
      await swarm.destroy().catch(() => {})
      await store.close().catch(() => {})
    }
  }
}

async function connectRpcClient(bootstrap, keyPair, autobaseKey) {
  const swarm = new Hyperswarm({ bootstrap, keyPair })

  const connection = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RPC connection timed out')), 10000)

    swarm.on('connection', (conn) => {
      clearTimeout(timer)
      conn.on('error', () => {})
      resolve(conn)
    })
  })

  const rpcDiscoveryKey = crypto
    .createHash('sha256')
    .update(autobaseKey)
    .update('qvac-registry-rpc')
    .digest()
  swarm.join(rpcDiscoveryKey, { client: true, server: false })
  await swarm.flush()

  const conn = await connection
  const rpc = new ProtomuxRPC(conn, {
    protocol: 'qvac-registry-rpc',
    valueEncoding: cenc.json
  })

  return {
    rpc,
    async cleanup() {
      conn.destroy()
      await swarm.destroy().catch(() => {})
    }
  }
}
