'use strict'

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const createTestnet = require('hyperdht/testnet')
const IdEnc = require('hypercore-id-encoding')
const crypto = require('crypto')

function deriveRpcDiscoveryKey (autobaseKey) {
  return crypto.createHash('sha256')
    .update(autobaseKey)
    .update('qvac-registry-rpc')
    .digest()
}

test('peer filter accepts connection from known indexer key', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const server = new Hyperswarm({ bootstrap })
  const client = new Hyperswarm({ bootstrap })

  server.on('connection', (conn) => { conn.on('error', () => {}) })

  t.teardown(async () => {
    await client.destroy().catch(() => {})
    await server.destroy().catch(() => {})
  })

  const allowedKeys = new Set([IdEnc.normalize(server.keyPair.publicKey)])
  const topic = crypto.randomBytes(32)

  server.join(topic, { server: true, client: false })
  await server.flush()

  const accepted = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no connection within 15s')), 15000)

    client.on('connection', (conn, peerInfo) => {
      conn.on('error', () => {})
      const peerKey = IdEnc.normalize(peerInfo.publicKey)

      if (!allowedKeys.has(peerKey)) {
        conn.destroy()
        return
      }

      clearTimeout(timer)
      resolve(peerKey)
    })
  })

  client.join(topic, { client: true, server: false })
  await client.flush()

  const connectedKey = await accepted
  t.is(connectedKey, IdEnc.normalize(server.keyPair.publicKey), 'accepted known indexer')
})

test('peer filter rejects connection when peer key not in allowlist', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const server = new Hyperswarm({ bootstrap })
  const client = new Hyperswarm({ bootstrap })

  t.teardown(async () => {
    await client.destroy().catch(() => {})
    await server.destroy().catch(() => {})
  })

  // Allowlist contains a random key that doesn't match the server
  const fakeIndexerKey = crypto.randomBytes(32)
  const allowedKeys = new Set([IdEnc.normalize(fakeIndexerKey)])
  const topic = crypto.randomBytes(32)

  server.on('connection', (conn) => { conn.on('error', () => {}) })
  server.join(topic, { server: true, client: false })
  await server.flush()

  const rejected = []

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 5000)

    client.on('connection', (conn, peerInfo) => {
      const peerKey = IdEnc.normalize(peerInfo.publicKey)

      if (!allowedKeys.has(peerKey)) {
        rejected.push(peerKey)
        conn.on('error', () => {})
        conn.destroy()
        return
      }

      clearTimeout(timer)
      resolve('accepted')
    })

    client.join(topic, { client: true, server: false })
    client.flush()
  })

  t.is(result, 'timeout', 'no connection was accepted (all rejected by filter)')
  t.ok(rejected.length > 0, 'at least one connection was rejected')
  t.is(rejected[0], IdEnc.normalize(server.keyPair.publicKey), 'rejected peer was the server')
})

test('topic-based fallback connects without indexer keys', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const server = new Hyperswarm({ bootstrap })
  const client = new Hyperswarm({ bootstrap })

  server.on('connection', (conn) => { conn.on('error', () => {}) })

  t.teardown(async () => {
    await client.destroy().catch(() => {})
    await server.destroy().catch(() => {})
  })

  const autobaseKey = crypto.randomBytes(32)
  const rpcTopic = deriveRpcDiscoveryKey(autobaseKey)

  server.join(rpcTopic, { server: true, client: false })
  await server.flush()

  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no connection within 15s')), 15000)

    client.on('connection', (conn, peerInfo) => {
      conn.on('error', () => {})
      clearTimeout(timer)
      resolve(IdEnc.normalize(peerInfo.publicKey))
    })
  })

  client.join(rpcTopic, { client: true, server: false })
  await client.flush()

  const peerKey = await connected
  t.is(peerKey, IdEnc.normalize(server.keyPair.publicKey), 'topic discovery connected to server')
})
