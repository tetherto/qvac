'use strict'

const crypto = require('crypto')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const ProtomuxRPC = require('protomux-rpc')
const IdEnc = require('hypercore-id-encoding')
const cenc = require('compact-encoding')
const { ENV_KEYS } = require('../../shared/constants')

const CAPACITY_CONNECTION_TIMEOUT_MS = 10000
const CAPACITY_RPC_TIMEOUT_MS = 5000

/**
 * Derive a dedicated RPC discovery key from the autobase key.
 * Must match the derivation in registry-service.js.
 */
function deriveRpcDiscoveryKey(autobaseKey) {
  return crypto.createHash('sha256').update(autobaseKey).update('qvac-registry-rpc').digest()
}

async function connectToRegistry({
  config,
  logger = console,
  storage = './temp-client-storage',
  timeout = 30000,
  primaryKey = null,
  targetPeer = null,
  indexerKeys = null
}) {
  const autobaseKeyEncoded = config.getAutobaseBootstrapKey()
  if (!autobaseKeyEncoded) {
    throw new Error(
      'QVAC_AUTOBASE_KEY not set. Run "node scripts/bin.js run" once to initialize keys.'
    )
  }

  const resolvedPrimaryKey = config.getWriterPrimaryKey(primaryKey)
  const storeOpts = resolvedPrimaryKey ? { primaryKey: resolvedPrimaryKey, unsafe: true } : {}
  const store = new Corestore(storage, storeOpts)
  await store.ready()

  const keyPair = await getWriterKeyPair(store, logger)
  const swarm = new Hyperswarm({ keyPair })
  let resolved = false

  const cleanup = async () => {
    await Promise.allSettled([swarm.destroy().catch(() => {}), store.close().catch(() => {})])
  }

  const autobaseKey = IdEnc.decode(autobaseKeyEncoded)

  // Resolve indexer keys: parameter > config > empty
  const resolvedIndexerKeys = indexerKeys || config.getIndexerKeys()
  const useDirectConnect = resolvedIndexerKeys.length > 0

  // Build a set of allowed peer keys for connection filtering
  const allowedPeerKeys = useDirectConnect
    ? new Set(resolvedIndexerKeys.map((k) => IdEnc.normalize(IdEnc.decode(k))))
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
        logger.info('RPC Client: Skipping peer (waiting for target)', {
          peer: peerKey,
          target: targetPeerNormalized
        })
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

      conn.on('error', (err) => {
        logger.warn(
          {
            peer: peerKey,
            error: err.message,
            code: err.code
          },
          'RPC Client: connection error'
        )
      })

      const rpc = new ProtomuxRPC(conn, {
        protocol: 'qvac-registry-rpc',
        valueEncoding: cenc.json
      })
      store.replicate(conn)

      // lunte-disable-next-line require-await
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

async function connectToRegistryByCapacity({
  config,
  logger = console,
  storage = './temp-client-storage',
  timeout = 30000,
  primaryKey = null,
  indexerKeys = null,
  connectionTimeout = CAPACITY_CONNECTION_TIMEOUT_MS,
  capacityTimeout = CAPACITY_RPC_TIMEOUT_MS,
  connect = connectToRegistry
}) {
  const resolvedIndexerKeys = indexerKeys || config.getIndexerKeys()
  const peerKeys = [
    ...new Set(resolvedIndexerKeys.map((key) => IdEnc.normalize(IdEnc.decode(key))))
  ]

  if (peerKeys.length === 0) {
    logger.warn('RPC Client: No indexer keys configured; using legacy peer selection')
    return connect({ config, logger, storage, timeout, primaryKey, indexerKeys })
  }

  const candidates = []

  for (const peerKey of peerKeys) {
    let probe = null
    try {
      probe = await connect({
        config,
        logger,
        storage,
        timeout: connectionTimeout,
        primaryKey,
        targetPeer: peerKey,
        indexerKeys: [peerKey]
      })

      const response = await probe.rpc.request(
        'get-storage-capacity',
        {},
        {
          timeout: capacityTimeout
        }
      )
      const availableBytes = parseAvailableBytes(response?.availableBytes)
      if (availableBytes === null) throw new Error('Invalid storage capacity response')

      candidates.push({ peerKey, availableBytes })
    } catch (err) {
      const errorCode = getErrorCode(err)
      if (errorCode === 'ERR_WRITER_UNAUTHORIZED') {
        logger.warn(
          { peer: peerKey, error: err.message, code: errorCode },
          'RPC Client: Capacity probe authorization failed'
        )
        throw err
      }

      logger.warn(
        { peer: peerKey, error: err.message, code: errorCode },
        'RPC Client: Capacity probe failed'
      )
    } finally {
      if (probe) await probe.cleanup()
    }
  }

  const winner = selectPeerByCapacity(candidates)
  if (!winner) {
    logger.warn('RPC Client: Capacity selection unavailable; using legacy peer selection')
    return connect({ config, logger, storage, timeout, primaryKey, indexerKeys })
  }

  logger.info(
    { peer: winner.peerKey, availableBytes: winner.availableBytes.toString() },
    'RPC Client: Selected indexer with most available storage'
  )

  return connect({
    config,
    logger,
    storage,
    timeout,
    primaryKey,
    targetPeer: winner.peerKey,
    indexerKeys: [winner.peerKey]
  })
}

function parseAvailableBytes(value) {
  if (typeof value === 'bigint' && value >= 0n) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  return null
}

function selectPeerByCapacity(candidates) {
  const valid = candidates
    .map((candidate) => ({
      ...candidate,
      availableBytes: parseAvailableBytes(candidate.availableBytes)
    }))
    .filter((candidate) => candidate.availableBytes !== null)

  valid.sort((a, b) => {
    if (a.availableBytes > b.availableBytes) return -1
    if (a.availableBytes < b.availableBytes) return 1
    return a.peerKey.localeCompare(b.peerKey)
  })

  return valid[0] || null
}

function getErrorCode(err) {
  return err?.cause?.code || err?.code || null
}

function getKeyPairFromEnv() {
  const publicKeyHex = process.env[ENV_KEYS.QVAC_WRITER_PUBLIC_KEY]
  const secretKeyHex = process.env[ENV_KEYS.QVAC_WRITER_SECRET_KEY]

  if (!publicKeyHex || !secretKeyHex) return null

  return {
    publicKey: Buffer.from(publicKeyHex, 'hex'),
    secretKey: Buffer.from(secretKeyHex, 'hex')
  }
}

async function getWriterKeyPair(store, logger) {
  const envPair = getKeyPairFromEnv()
  if (envPair) {
    if (logger?.debug) {
      logger.debug(
        {
          writer: IdEnc.normalize(envPair.publicKey)
        },
        'RPC Client: Using writer keypair from environment'
      )
    }
    return envPair
  }

  const keyPair = await store.createKeyPair('writer-key')
  if (logger?.debug) {
    logger.debug(
      {
        writer: IdEnc.normalize(keyPair.publicKey)
      },
      'RPC Client: Using writer keypair from corestore'
    )
  }
  return keyPair
}

async function updateModelMetadata({
  config,
  path,
  source,
  metadata,
  logger = console,
  storage = './temp-client-storage',
  timeout = 30000
}) {
  const connection = await connectToRegistry({ config, logger, storage, timeout })
  try {
    const result = await connection.rpc.request('update-model-metadata', {
      path,
      source,
      ...metadata
    })
    return result
  } finally {
    await connection.cleanup()
  }
}

module.exports = {
  CAPACITY_CONNECTION_TIMEOUT_MS,
  CAPACITY_RPC_TIMEOUT_MS,
  connectToRegistry,
  connectToRegistryByCapacity,
  parseAvailableBytes,
  selectPeerByCapacity,
  updateModelMetadata
}
