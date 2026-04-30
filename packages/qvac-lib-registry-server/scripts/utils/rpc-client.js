'use strict'

const crypto = require('crypto')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const ProtomuxRPC = require('protomux-rpc')
const IdEnc = require('hypercore-id-encoding')
const cenc = require('compact-encoding')
const { ENV_KEYS } = require('../../shared/constants')

/**
 * Derive a dedicated RPC discovery key from the autobase key.
 * Must match the derivation in registry-service.js.
 */
function deriveRpcDiscoveryKey (autobaseKey) {
  return crypto.createHash('sha256')
    .update(autobaseKey)
    .update('qvac-registry-rpc')
    .digest()
}

async function connectToRegistry ({ config, logger = console, storage = './temp-client-storage', timeout = 30000, primaryKey = null, targetPeer = null, indexerKeys = null }) {
  const autobaseKeyEncoded = config.getAutobaseBootstrapKey()
  if (!autobaseKeyEncoded) {
    throw new Error('QVAC_AUTOBASE_KEY not set. Run "node scripts/bin.js run" once to initialize keys.')
  }

  const resolvedPrimaryKey = config.getWriterPrimaryKey(primaryKey)
  const storeOpts = resolvedPrimaryKey ? { primaryKey: resolvedPrimaryKey, unsafe: true } : {}
  const store = new Corestore(storage, storeOpts)
  await store.ready()

  const keyPair = await getWriterKeyPair(store, logger)
  const swarm = new Hyperswarm({ keyPair })
  let resolved = false

  const cleanup = async () => {
    await Promise.allSettled([
      swarm.destroy().catch(() => {}),
      store.close().catch(() => {})
    ])
  }

  const autobaseKey = IdEnc.decode(autobaseKeyEncoded)

  // Resolve indexer keys: parameter > config > empty
  const resolvedIndexerKeys = indexerKeys || config.getIndexerKeys()
  const useDirectConnect = resolvedIndexerKeys.length > 0

  // Build a set of allowed peer keys for connection filtering
  const allowedPeerKeys = useDirectConnect
    ? new Set(resolvedIndexerKeys.map(k => IdEnc.normalize(IdEnc.decode(k))))
    : null

  if (useDirectConnect) {
    logger.info('RPC Client: Connecting via direct indexer keys (Noise-authenticated)', {
      indexerCount: resolvedIndexerKeys.length
    })
  } else {
    const rpcDiscoveryKey = deriveRpcDiscoveryKey(autobaseKey)
    logger.info('RPC Client: Connecting via RPC topic (legacy)', {
      autobaseKey: IdEnc.normalize(autobaseKey),
      rpcDiscoveryKey: IdEnc.normalize(rpcDiscoveryKey)
    })
  }

  // Normalize targetPeer if provided
  const targetPeerNormalized = targetPeer ? IdEnc.normalize(IdEnc.decode(targetPeer)) : null

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      if (resolved) return
      resolved = true
      await cleanup()
      reject(new Error('Timeout: Could not connect to registry server'))
    }, timeout)

    const onConnection = (conn, peerInfo) => {
      if (resolved) return

      const peerKey = IdEnc.normalize(peerInfo.publicKey)

      // If targeting a specific peer, skip others
      if (targetPeerNormalized && peerKey !== targetPeerNormalized) {
        logger.info('RPC Client: Skipping peer (waiting for target)', { peer: peerKey, target: targetPeerNormalized })
        return
      }

      // When using direct connect, only accept known indexer keys
      if (allowedPeerKeys && !allowedPeerKeys.has(peerKey)) {
        logger.info('RPC Client: Ignoring unknown peer', { peer: peerKey })
        return
      }

      resolved = true
      clearTimeout(timer)

      logger.info('RPC Client: Connected to server', { peer: peerKey })

      const rpc = new ProtomuxRPC(conn, {
        protocol: 'qvac-registry-rpc',
        valueEncoding: cenc.json
      })
      store.replicate(conn)

      const closeConnection = async () => {
        try {
          conn.destroy()
        } catch (err) {
          // Connection may already be destroyed, safe to ignore
        }
      }

      resolve({
        rpc,
        store,
        swarm,
        peerKey,
        cleanup: async () => {
          await closeConnection()
          await cleanup()
        }
      })
    }

    const onError = async (err) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      await cleanup()
      reject(err)
    }

    swarm.on('connection', onConnection)
    swarm.on('error', onError)

    ;(async () => {
      try {
        if (useDirectConnect) {
          const picked = resolvedIndexerKeys[Math.floor(Math.random() * resolvedIndexerKeys.length)]
          logger.info('RPC Client: Connecting to indexer', { peer: picked })
          swarm.joinPeer(IdEnc.decode(picked))
        } else {
          const rpcDiscoveryKey = deriveRpcDiscoveryKey(autobaseKey)
          swarm.join(rpcDiscoveryKey, { client: true, server: false })
        }
        await swarm.flush()
        logger.debug('RPC Client: Swarm joined and flushed, waiting for connection...')
      } catch (err) {
        await onError(err)
      }
    })()
  })
}

function getKeyPairFromEnv () {
  const publicKeyHex = process.env[ENV_KEYS.QVAC_WRITER_PUBLIC_KEY]
  const secretKeyHex = process.env[ENV_KEYS.QVAC_WRITER_SECRET_KEY]

  if (!publicKeyHex || !secretKeyHex) return null

  return {
    publicKey: Buffer.from(publicKeyHex, 'hex'),
    secretKey: Buffer.from(secretKeyHex, 'hex')
  }
}

async function getWriterKeyPair (store, logger) {
  const envPair = getKeyPairFromEnv()
  if (envPair) {
    if (logger?.debug) {
      logger.debug({
        writer: IdEnc.normalize(envPair.publicKey)
      }, 'RPC Client: Using writer keypair from environment')
    }
    return envPair
  }

  const keyPair = await store.createKeyPair('writer-key')
  if (logger?.debug) {
    logger.debug({
      writer: IdEnc.normalize(keyPair.publicKey)
    }, 'RPC Client: Using writer keypair from corestore')
  }
  return keyPair
}

async function updateModelMetadata ({ config, path, source, metadata, logger = console, storage = './temp-client-storage', timeout = 30000 }) {
  const connection = await connectToRegistry({ config, logger, storage, timeout })
  try {
    const result = await connection.rpc.request('update-model-metadata', { path, source, ...metadata })
    return result
  } finally {
    await connection.cleanup()
  }
}

module.exports = {
  connectToRegistry,
  updateModelMetadata
}
