'use strict'

const crypto = require('crypto')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const ProtomuxRPC = require('protomux-rpc')
const IdEnc = require('hypercore-id-encoding')
const cenc = require('compact-encoding')
const { ENV_KEYS } = require('../../shared/constants')

const PING_TIMEOUT_MS = 5000

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

async function connectToRegistry ({ config, logger = console, storage = './temp-client-storage', timeout = 30000, primaryKey = null }) {
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
  const rejectedPeers = new Set()

  const cleanup = async () => {
    await Promise.allSettled([
      swarm.destroy().catch(() => {}),
      store.close().catch(() => {})
    ])
  }

  const autobaseKey = IdEnc.decode(autobaseKeyEncoded)

  // Use dedicated RPC topic instead of autobase topic to avoid blind peers
  const rpcDiscoveryKey = deriveRpcDiscoveryKey(autobaseKey)

  logger.info('RPC Client: Connecting via dedicated RPC topic', {
    autobaseKey: IdEnc.normalize(autobaseKey),
    rpcDiscoveryKey: IdEnc.normalize(rpcDiscoveryKey)
  })

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      if (resolved) return
      resolved = true
      await cleanup()
      const rejectedList = rejectedPeers.size > 0
        ? ` (rejected ${rejectedPeers.size} peer(s) that failed ping)`
        : ''
      reject(new Error(`Timeout: Could not connect to registry server${rejectedList}`))
    }, timeout)

    const onConnection = async (conn, peerInfo) => {
      if (resolved) return

      const peerKey = IdEnc.normalize(peerInfo.publicKey)

      // Skip peers we already rejected (e.g., blind peers that failed ping)
      if (rejectedPeers.has(peerKey)) {
        logger.debug('RPC Client: Ignoring reconnection from rejected peer', { peer: peerKey })
        return
      }

      logger.info('RPC Client: Connected to peer, verifying...', { peer: peerKey })

      const rpc = new ProtomuxRPC(conn, {
        protocol: 'qvac-registry-rpc',
        valueEncoding: cenc.json
      })
      store.replicate(conn)

      // Verify this is the actual server (not a blind peer) via ping
      const isServer = await verifyServerConnection(rpc, peerKey, logger)

      if (!isServer) {
        rejectedPeers.add(peerKey)
        logger.warn('RPC Client: Peer rejected (blind peer - no RPC protocol), waiting for server...', {
          peer: peerKey,
          rejectedCount: rejectedPeers.size
        })
        try {
          conn.destroy()
        } catch {
          // Ignore destroy errors
        }
        return
      }

      if (resolved) return
      resolved = true
      clearTimeout(timer)

      logger.info('RPC Client: Connection accepted', { peer: peerKey })

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
        swarm.join(rpcDiscoveryKey, { client: true, server: false })
        await swarm.flush()
        logger.debug('RPC Client: Swarm joined and flushed, waiting for connection...')
      } catch (err) {
        await onError(err)
      }
    })()
  })
}

/**
 * Verify connection is to actual registry server (not a blind peer).
 * Blind peers replicate data but don't have RPC responders.
 *
 * Returns:
 * - true: Connection verified (ping responded or timed out - meaning RPC channel is functional)
 * - false: Connection rejected (CHANNEL_CLOSED - blind peer doesn't speak RPC protocol)
 */
async function verifyServerConnection (rpc, peerKey, logger) {
  try {
    const pingPromise = rpc.request('ping', {})
    const timeoutPromise = new Promise((_resolve, reject) => {
      const err = new Error('Ping timeout')
      err.code = 'PING_TIMEOUT'
      setTimeout(() => reject(err), PING_TIMEOUT_MS)
    })

    const response = await Promise.race([pingPromise, timeoutPromise])

    if (response?.role === 'registry-server') {
      logger.debug('RPC Client: Ping response received', {
        peer: peerKey,
        isIndexer: response.isIndexer
      })
      return true
    }

    // Unexpected response but channel is functional - accept connection
    logger.debug('RPC Client: Unexpected ping response, accepting anyway', { peer: peerKey, response })
    return true
  } catch (err) {
    // CHANNEL_CLOSED means blind peer (no RPC protocol) - reject
    if (err.code === 'CHANNEL_CLOSED') {
      logger.debug('RPC Client: Channel closed (blind peer)', {
        peer: peerKey,
        error: err.message,
        code: err.code
      })
      return false
    }

    // Timeout or other errors mean RPC channel exists but server doesn't have ping handler
    // This is acceptable (backwards compatible with old servers)
    logger.debug('RPC Client: Ping not supported, accepting connection (backwards compatible)', {
      peer: peerKey,
      error: err.message,
      code: err.code
    })
    return true
  }
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
