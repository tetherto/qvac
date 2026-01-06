'use strict'

const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const ProtomuxRPC = require('protomux-rpc')
const IdEnc = require('hypercore-id-encoding')
const cenc = require('compact-encoding')
const { ENV_KEYS } = require('../../shared/constants')

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

  const cleanup = async () => {
    await Promise.allSettled([
      swarm.destroy().catch(() => {}),
      store.close().catch(() => {})
    ])
  }

  const autobaseKey = IdEnc.decode(autobaseKeyEncoded)
  const core = store.get({ key: autobaseKey })
  await core.ready()

  if (logger?.debug) {
    logger.debug('RPC Client: Connecting via Autobase discovery key', {
      autobaseKey: IdEnc.normalize(core.key),
      discoveryKey: IdEnc.normalize(core.discoveryKey)
    })
  }

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      if (resolved) return
      resolved = true
      await cleanup()
      reject(new Error('Timeout: Could not connect to service'))
    }, timeout)

    const onConnection = (conn, peerInfo) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)

      if (logger?.debug) {
        logger.debug('Connected to service', {
          peer: IdEnc.normalize(peerInfo.publicKey),
          writer: IdEnc.normalize(keyPair.publicKey)
        })
      }

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
        swarm.join(core.discoveryKey, { client: true, server: false })
        await swarm.flush()
        if (logger?.debug) {
          logger.debug('RPC Client: Swarm joined and flushed, waiting for connection...')
        }
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
