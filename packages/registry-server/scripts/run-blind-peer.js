'use strict'

const { command, flag } = require('paparam')
const path = require('path')
const IdEnc = require('hypercore-id-encoding')
const BlindPeer = require('blind-peer')
const logger = require('../lib/logger')

const DEFAULT_STORAGE = path.resolve(process.cwd(), './blind-peer-data')
const DEFAULT_MAX_STORAGE_MB = 50_000

function formatBytes (bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

const cli = command(
  'run-blind-peer',
  flag('--storage|-s [path]', `Storage path for blind peer (default: ${DEFAULT_STORAGE})`),
  flag('--trusted|-t [key]', 'Blind peer public key allowed to request announce=true').multiple(),
  flag('--max-storage [mb]', `Max storage in MB (default: ${DEFAULT_MAX_STORAGE_MB})`),
  flag('--port [int]', 'Preferred DHT port to bind (optional)'),
  async ({ flags }) => {
    const storage = flags.storage || DEFAULT_STORAGE
    const trusted = (flags.trusted || [])
      .map(key => key.trim())
      .filter(Boolean)
      .map(key => {
        try {
          return IdEnc.decode(key)
        } catch (err) {
          throw new Error(`Invalid trusted key ${key}: ${err.message}`)
        }
      })

    const maxBytes = parseInt(flags.maxStorage || DEFAULT_MAX_STORAGE_MB, 10) * 1_000_000
    const port = flags.port ? parseInt(flags.port, 10) : undefined

    logger.info(`Starting blind peer - storage: ${storage}, trusted peers: ${trusted.length}, max bytes: ${maxBytes}, port: ${port || 'auto'}`)

    const blindPeer = new BlindPeer(storage, {
      maxBytes,
      trustedPubKeys: trusted,
      port
    })

    await blindPeer.ready()
    await blindPeer.listen()

    blindPeer.swarm.on('connection', (conn, peerInfo) => {
      logger.info(`Swarm connection opened - peer: ${IdEnc.normalize(peerInfo.publicKey)}`)

      conn.on('close', () => {
        logger.info(`Swarm connection closed - peer: ${IdEnc.normalize(peerInfo.publicKey)}`)
      })
    })

    blindPeer.on('add-core', (record, isNew, stream) => {
      const peer = stream.remotePublicKey ? IdEnc.normalize(stream.remotePublicKey) : 'unknown'
      logger.info('Core added', {
        key: IdEnc.normalize(record.key),
        announce: record.announce,
        peer,
        isNew
      })
    })

    blindPeer.on('announce-core', (core) => {
      logger.info(`Core announced to DHT - key: ${IdEnc.normalize(core.key)}, length: ${core.length}`)
    })

    blindPeer.on('core-downloaded', (core) => {
      logger.info('Core fully downloaded', {
        key: IdEnc.normalize(core.key),
        length: core.length,
        byteLength: formatBytes(core.byteLength)
      })
    })

    blindPeer.on('downgrade-announce', ({ record, remotePublicKey }) => {
      const peer = remotePublicKey ? IdEnc.normalize(remotePublicKey) : 'unknown'
      logger.warn(`Announce request rejected (untrusted peer) - key: ${IdEnc.normalize(record.key)}, peer: ${peer}`)
    })

    blindPeer.on('gc-start', ({ bytesToClear }) => {
      logger.info('GC starting', { bytesToClear: formatBytes(bytesToClear) })
    })

    blindPeer.on('gc-done', ({ bytesCleared }) => {
      logger.info('GC completed', { bytesCleared: formatBytes(bytesCleared) })
    })

    logger.info('Blind peer ready', {
      publicKey: IdEnc.normalize(blindPeer.publicKey),
      encryptionKey: IdEnc.normalize(blindPeer.encryptionPublicKey),
      trustedPeers: trusted.length,
      maxBytes: formatBytes(maxBytes)
    })

    let shuttingDown = false
    const shutdown = async () => {
      if (shuttingDown) return
      shuttingDown = true
      logger.info('Shutting down blind peer')

      try {
        await blindPeer.close()
        logger.info('Blind peer shut down')
      } catch (err) {
        logger.error('Failed to shut down blind peer cleanly:', err.message)
        process.exitCode = 1
      } finally {
        process.exit()
      }
    }

    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  }
)

cli.parse()
