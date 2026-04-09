'use strict'

// Load environment variables from .env
require('dotenv').config()

const { command, flag } = require('paparam')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const DHT = require('hyperdht')
const IdEnc = require('hypercore-id-encoding')
const pino = require('pino')
const path = require('path')
const fs = require('fs')

const RegistryService = require('../lib/registry-service')
const RegistryConfig = require('../lib/config')
const { AUTOBASE_NAMESPACE } = require('@qvac/registry-schema')

const DEFAULT_STORAGE = './corestore'
const DEFAULT_WRITER_STORAGE = './writer-storage'

const DEFAULT_COMPACTION_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

function toInt (val) {
  const n = parseInt(val, 10)
  return Number.isNaN(n) ? undefined : n
}

const runCmd = command('run',
  flag('--storage|-s [path]', `storage path (default ${DEFAULT_STORAGE})`),
  flag('--bootstrap|-b [key]', 'Autobase bootstrap key (hex)'),
  flag('--ack-interval [ms]', 'Autobase ack interval in ms (default: 5000)'),
  flag('--ack-threshold [n]', 'Autobase ack threshold, lower = less latency but more writes (default: 0)'),
  flag('--blind-peers [keys]', 'Comma-separated blind peer public keys (z-base-32 or hex)'),
  flag('--primary-key [key]', 'Primary key for deterministic key derivation (hex or z-base-32, testing/development only)'),
  flag('--clear-after-reseed', 'Clear blob blocks after successful replication to blind peers'),
  flag('--compaction-interval [ms]', `Periodic RocksDB compaction interval in ms (default: ${DEFAULT_COMPACTION_INTERVAL_MS}, 0 to disable)`),
  flag('--skip-storage-check', 'Skip storage/bootstrap key mismatch check (use when joining existing cluster with fresh storage)'),
  async function ({ flags }) {
    const logger = createLogger()

    const config = new RegistryConfig({ logger })
    const storagePath = config.getRegistryStorage(flags.storage || DEFAULT_STORAGE)

    const blindPeerKeys = flags.blindPeers
      ? flags.blindPeers.split(',').map(key => key.trim()).filter(Boolean)
      : config.getBlindPeerKeys()

    const primaryKey = config.getPrimaryKey(flags.primaryKey)
    if (primaryKey) {
      logger.warn('Using deterministic primary key with unsafe mode — keys are predictable. Do NOT use in production.')
    }
    const storeOpts = primaryKey ? { primaryKey, unsafe: true } : {}
    const store = new Corestore(storagePath, storeOpts)
    await store.ready()

    const keyPair = await store.createKeyPair('rpc-key')
    const dht = new DHT({ keyPair })
    const swarm = new Hyperswarm({ dht, keyPair })

    const bootstrapHex = config.getAutobaseBootstrapKey(flags.bootstrap)
    const autobaseBootstrap = bootstrapHex ? IdEnc.decode(bootstrapHex) : null

    const compactionIntervalMs = flags.compactionInterval !== undefined
      ? parseInt(flags.compactionInterval, 10)
      : DEFAULT_COMPACTION_INTERVAL_MS

    const service = new RegistryService(
      store.namespace(AUTOBASE_NAMESPACE),
      swarm,
      config,
      {
        logger,
        ackInterval: toInt(flags.ackInterval),
        ackThreshold: toInt(flags.ackThreshold),
        autobaseBootstrap,
        blindPeerKeys,
        clearAfterReseed: flags.clearAfterReseed,
        compactionIntervalMs,
        skipStorageCheck: flags.skipStorageCheck
      }
    )

    await service.ready()

    config.setAutobaseKey(IdEnc.normalize(service.base.key))
    config.setRegistryCoreKey(IdEnc.normalize(service.registryCoreKey))

    logServiceInfo(logger, service)
    registerShutdown(logger, service, swarm, store)
  }
)

const initWriter = command('init-writer',
  flag('--storage|-s [path]', `writer storage path (default ${DEFAULT_WRITER_STORAGE})`),
  flag('--primary-key [key]', 'Primary key for deterministic writer keypair (hex or z-base-32, testing/development only)'),
  async function ({ flags }) {
    const logger = createLogger()
    const storagePath = path.resolve(flags.storage || DEFAULT_WRITER_STORAGE)

    try {
      const config = new RegistryConfig({ logger })
      const primaryKey = config.getWriterPrimaryKey(flags.primaryKey)
      if (primaryKey) {
        logger.warn('Using deterministic primary key with unsafe mode — keys are predictable. Do NOT use in production.')
      }
      const storeOpts = primaryKey ? { primaryKey, unsafe: true } : {}
      const store = new Corestore(storagePath, storeOpts)
      await store.ready()

      const keyPair = await store.createKeyPair('writer-key')
      const publicKeyHex = keyPair.publicKey.toString('hex')
      const publicKeyZ32 = IdEnc.normalize(keyPair.publicKey)

      await store.close()

      logger.info('Writer keypair initialized')
      logger.info({ storage: storagePath }, 'Storage path')
      if (primaryKey) {
        logger.info('Using deterministic primary key (testing/development only)')
      }
      logger.info({ z32: publicKeyZ32 }, 'Writer public key (z-base-32)')
      logger.info({ hex: publicKeyHex }, 'Writer public key (hex)')

      const envResult = appendWriterKeyToEnv(publicKeyHex, logger)
      if (envResult.added) {
        logger.info({ file: envResult.file }, 'Writer key added to QVAC_ALLOWED_WRITER_KEYS in .env')
        logger.info('Restart the registry service for changes to take effect')
      } else if (envResult.alreadyExists) {
        logger.info('Writer key already exists in QVAC_ALLOWED_WRITER_KEYS')
      }

      process.exit(0)
    } catch (err) {
      logger.error({ err }, 'Failed to initialize writer key')
      process.exit(1)
    }
  }
)

const syncModelsCmd = command('sync-models',
  flag('--file [path]', 'Path to models JSON file (default: ./data/models.prod.json)'),
  flag('--dry-run', 'Preview changes without applying'),
  async function ({ flags }) {
    const { syncModels } = require('./sync-models')
    const args = []
    if (flags.file) args.push(`--file=${flags.file}`)
    if (flags.dryRun) args.push('--dry-run')
    process.argv = ['node', 'sync-models.js', ...args]
    await syncModels()
  }
)

const cmd = command('registry', runCmd, initWriter, syncModelsCmd)

cmd.parse()

function registerShutdown (logger, service, swarm, store) {
  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    logger.info('Shutting down gracefully…')
    try {
      await service.close()
      await swarm.destroy()
      await store.close()
      logger.info('Shutdown complete')
      process.exit(0)
    } catch (err) {
      logger.error({ err }, 'Shutdown failed')
      process.exit(1)
    }
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

function logServiceInfo (logger, service) {
  logger.info('Registry service ready')
  logger.info({ key: IdEnc.normalize(service.base.key) }, 'Autobase key')
  logger.info({ key: IdEnc.normalize(service.registryCoreKey) }, 'Registry view key')
  logger.info({ key: IdEnc.normalize(service.registryDiscoveryKey) }, 'Registry discovery key (DHT topic)')
  logger.info({ key: IdEnc.normalize(service.serverPublicKey) }, 'RPC server public key')
  logger.info({ key: IdEnc.normalize(service.base.local.key) }, 'Writer local key')
  logger.info({ length: service.view?.core?.length ?? 0 }, 'View core length')
}

function createLogger () {
  return pino({
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname'
      }
    }
  })
}

function appendWriterKeyToEnv (publicKeyHex, logger) {
  const envPath = path.resolve(process.cwd(), '.env')
  const envKey = 'QVAC_ALLOWED_WRITER_KEYS'

  let content = ''

  try {
    content = fs.readFileSync(envPath, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  const lines = content.split('\n')
  let keyLineIndex = -1
  let existingKeys = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith(`${envKey}=`)) {
      keyLineIndex = i
      const value = line.slice(`${envKey}=`.length)
      existingKeys = value.split(',').map(k => k.trim()).filter(Boolean)
      break
    }
  }

  if (existingKeys.includes(publicKeyHex)) {
    return { added: false, alreadyExists: true, file: envPath }
  }

  if (keyLineIndex >= 0) {
    existingKeys.push(publicKeyHex)
    lines[keyLineIndex] = `${envKey}=${existingKeys.join(',')}`
  } else {
    const newLine = `${envKey}=${publicKeyHex}`
    if (content.length > 0 && !content.endsWith('\n')) {
      lines.push('')
    }
    lines.push(newLine)
  }

  let newContent = lines.join('\n')
  if (!newContent.endsWith('\n')) {
    newContent += '\n'
  }

  fs.writeFileSync(envPath, newContent, 'utf8')

  return { added: true, alreadyExists: false, file: envPath }
}
