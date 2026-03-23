'use strict'

const os = require('os')
const fs = require('fs')
const { performance } = require('perf_hooks')
const { pipeline } = require('stream/promises')

const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Hyperblobs = require('hyperblobs')
const HypercoreStats = require('hypercore-stats')
const HyperswarmStats = require('hyperswarm-stats')
const IdEnc = require('hypercore-id-encoding')
const byteSize = require('tiny-byte-size')
const path = require('#path')

const { RegistryDatabase } = require('@qvac/registry-schema')

/**
 * Normalize a blob core key into a Buffer regardless of input format.
 * Handles raw Buffer, { data: [...] } objects from HyperDB, and z32/hex strings.
 */
function decodeCoreKey (key) {
  if (Buffer.isBuffer(key)) return key
  if (typeof key === 'object' && key !== null && key.data) {
    return Buffer.from(key.data)
  }
  return IdEnc.decode(key)
}

/**
 * Collect a snapshot of network, connection, and hypercore stats.
 * All fields are plain values suitable for logging or formatting.
 */
function collectStats (swarmStats, hypercoreStats, blobCore, elapsedSec) {
  const bytesRx = swarmStats.dhtStats.udxBytesReceived
  const bytesTx = swarmStats.dhtStats.udxBytesTransmitted

  const peers = []
  for (const peer of blobCore.peers) {
    peers.push({
      key: IdEnc.normalize(peer.remotePublicKey),
      remoteLength: peer.remoteLength,
      remoteContiguous: peer.remoteContiguousLength
    })
  }

  return {
    elapsedSec,
    network: {
      bytesRx,
      bytesTx,
      rxPerSec: elapsedSec > 0 ? bytesRx / elapsedSec : 0,
      txPerSec: elapsedSec > 0 ? bytesTx / elapsedSec : 0,
      packetsRx: swarmStats.dhtStats.udxPacketsReceived,
      packetsTx: swarmStats.dhtStats.udxPacketsTransmitted,
      packetsDropped: swarmStats.dhtStats.udxPacketsDropped
    },
    connection: {
      firewalled: swarmStats.dhtStats.isFirewalled,
      blobPeers: blobCore.peers.length,
      attempted: swarmStats.connects.client.attempted,
      opened: swarmStats.connects.client.opened,
      closed: swarmStats.connects.client.closed,
      rtos: swarmStats.getRTOCountAcrossAllStreams(),
      fastRecoveries: swarmStats.getFastRecoveriesAcrossAllStreams(),
      retransmits: swarmStats.getRetransmitsAcrossAllStreams()
    },
    hypercore: {
      contiguousLength: blobCore.contiguousLength,
      length: blobCore.length,
      hotswaps: hypercoreStats.totalHotswaps
    },
    peers
  }
}

/**
 * Format a stats snapshot into a human-readable string.
 */
function formatStats (stats) {
  const n = stats.network
  const c = stats.connection
  const h = stats.hypercore

  let lines = '--- ' + stats.elapsedSec.toFixed(1) + 's elapsed ---\n'
  lines += 'Network (UDX)\n'
  lines += '  Bytes received:    ' + byteSize(n.bytesRx) + ' (' + byteSize(n.rxPerSec) + '/s)\n'
  lines += '  Bytes transmitted: ' + byteSize(n.bytesTx) + ' (' + byteSize(n.txPerSec) + '/s)\n'
  lines += '  Packets rx/tx:     ' + n.packetsRx + ' / ' + n.packetsTx + '\n'
  lines += '  Packets dropped:   ' + n.packetsDropped + '\n'
  lines += 'Connection\n'
  lines += '  Firewalled: ' + c.firewalled + '\n'
  lines += '  Blob peers: ' + c.blobPeers + '\n'
  lines += '  Attempted:  ' + c.attempted + '\n'
  lines += '  Opened:     ' + c.opened + '\n'
  lines += '  Closed:     ' + c.closed + '\n'
  lines += '  Issues:     rto=' + c.rtos + ' fast-recoveries=' + c.fastRecoveries + ' retransmits=' + c.retransmits + '\n'
  lines += 'Hypercore\n'
  lines += '  Blob core: ' + h.contiguousLength + ' / ' + h.length + ' (contiguous / length)\n'
  lines += '  Hotswaps:  ' + h.hotswaps + '\n'

  if (stats.peers.length > 0) {
    lines += '  Peers:\n'
    for (const p of stats.peers) {
      lines += '    ' + p.key + ' remote=' + p.remoteContiguous + '/' + p.remoteLength + '\n'
    }
  }

  return lines
}

/**
 * Format a final download summary into a human-readable string.
 */
function formatSummary (opts) {
  let lines = '='.repeat(50) + '\n'
  lines += 'FINAL SUMMARY\n'
  lines += '='.repeat(50) + '\n'
  lines += 'Download\n'
  lines += '  Model:     ' + opts.modelPath + '\n'
  lines += '  Size:      ' + byteSize(opts.totalBytes) + ' (' + opts.totalBlocks + ' blocks)\n'
  lines += '  Metadata:  ' + opts.metadataSec.toFixed(2) + 's\n'
  lines += '  Transfer:  ' + opts.transferSec.toFixed(2) + 's\n'
  lines += '  Avg speed: ' + byteSize(opts.avgSpeed) + '/s\n'
  lines += '  Total:     ' + opts.totalSec.toFixed(2) + 's\n'
  return lines
}

/**
 * Profile a blob download from the registry, printing periodic stats.
 *
 * @param {object} opts
 * @param {string} opts.registryCoreKey - Registry view core key (z32 or hex)
 * @param {string} opts.modelPath - Model path in the registry
 * @param {string} [opts.source] - Source filter (e.g. "hf", "s3")
 * @param {number} [opts.intervalSec=5] - Stats print interval in seconds
 * @param {number} [opts.timeout=120000] - Stream read timeout in ms
 * @param {function} [opts.onStats] - Called with (formattedString, rawStats) on each interval
 * @param {function} [opts.onLog] - Called with (message) for log output; defaults to console.log
 * @returns {Promise<object>} Summary with timing and stats
 */
async function profileDownload (opts) {
  const {
    registryCoreKey,
    modelPath,
    source,
    intervalSec = 5,
    timeout = 120000,
    onStats,
    onLog = console.log
  } = opts

  if (!registryCoreKey) throw new Error('registryCoreKey is required')
  if (!modelPath) throw new Error('modelPath is required')

  const tStart = performance.now()
  const tmpdir = path.join(os.tmpdir(), 'qvac-profile-' + Date.now())
  fs.mkdirSync(tmpdir, { recursive: true })

  const store = new Corestore(tmpdir)
  await store.ready()

  const swarm = new Hyperswarm()
  const hcStats = await HypercoreStats.fromCorestore(store, { cacheExpiryMs: 1000 })
  const swStats = new HyperswarmStats(swarm)

  swarm.on('connection', (conn, peerInfo) => {
    const key = peerInfo?.publicKey ? IdEnc.normalize(peerInfo.publicKey) : 'unknown'
    onLog('  [conn] peer ' + key + ' connected')
    store.replicate(conn)
    conn.on('error', (e) => onLog('  [conn] error: ' + e.message))
    conn.on('close', () => onLog('  [conn] peer ' + key + ' disconnected'))
  })

  const cleanupResources = async () => {
    await swarm.destroy()
    await store.close()
    try { fs.rmSync(tmpdir, { recursive: true, force: true }) } catch {}
  }

  try {
    const viewKey = IdEnc.decode(registryCoreKey)
    const viewCore = store.get({ key: viewKey })
    await viewCore.ready()

    onLog('View core key: ' + IdEnc.normalize(viewCore.key))

    const foundPeers = viewCore.findingPeers()
    swarm.join(viewCore.discoveryKey, { client: true, server: false })
    swarm.flush().then(() => foundPeers())

    await viewCore.update()
    const metadataSec = (performance.now() - tStart) / 1000

    const db = new RegistryDatabase(viewCore, { extension: false })
    await db.ready()

    onLog('Metadata synced in ' + metadataSec.toFixed(2) + 's (' + viewCore.length + ' blocks)')

    const model = await db.getModel(modelPath, source || undefined)
    if (!model) throw new Error('Model not found: ' + modelPath)

    const blob = model.blobBinding
    if (!blob || !blob.coreKey) throw new Error('Model has no blob binding')

    onLog('\nProfiling download: ' + model.path)
    onLog('  engine: ' + model.engine)
    onLog('  source: ' + model.source)
    onLog('  size: ' + byteSize(blob.byteLength) + ' (' + blob.blockLength + ' blocks)')
    onLog('')

    const coreKeyBuf = decodeCoreKey(blob.coreKey)
    const blobCore = store.get({ key: coreKeyBuf })
    await blobCore.ready()
    const blobs = new Hyperblobs(blobCore)
    await blobs.ready()

    onLog('Blob core key: ' + IdEnc.normalize(blobCore.key))
    onLog('Blob core discovery: ' + IdEnc.normalize(blobCore.discoveryKey))

    const foundBlobPeers = blobCore.findingPeers()
    swarm.join(blobCore.discoveryKey, { client: true, server: false })
    swarm.flush().then(() => foundBlobPeers())

    await blobCore.update()
    onLog('Blob core synced: length=' + blobCore.length)
    onLog('')

    const outputFile = path.join(tmpdir, 'download.bin')
    const tDownloadStart = performance.now()

    const emitStats = () => {
      const elapsed = (performance.now() - tDownloadStart) / 1000
      const raw = collectStats(swStats, hcStats, blobCore, elapsed)
      const formatted = formatStats(raw)
      if (onStats) {
        onStats(formatted, raw)
      } else {
        onLog(formatted)
      }
      return raw
    }

    const statsInterval = setInterval(emitStats, intervalSec * 1000)

    const rangeDownload = blobCore.download({
      start: blob.blockOffset,
      length: blob.blockLength
    })

    const readStream = blobs.createReadStream(blob, { wait: true, timeout })
    const writeStream = fs.createWriteStream(outputFile)

    try {
      await pipeline(readStream, writeStream)
    } finally {
      rangeDownload.destroy()
      clearInterval(statsInterval)
    }

    const totalSec = (performance.now() - tStart) / 1000
    const transferSec = (performance.now() - tDownloadStart) / 1000
    const avgSpeed = transferSec > 0 ? blob.byteLength / transferSec : 0

    const finalStats = emitStats()

    const summary = {
      modelPath: model.path,
      totalBytes: blob.byteLength,
      totalBlocks: blob.blockLength,
      metadataSec,
      transferSec,
      avgSpeed,
      totalSec,
      finalStats
    }

    onLog(formatSummary(summary))

    await blobs.close()
    await blobCore.close()

    return summary
  } finally {
    await cleanupResources()
  }
}

module.exports = {
  decodeCoreKey,
  collectStats,
  formatStats,
  formatSummary,
  profileDownload
}
