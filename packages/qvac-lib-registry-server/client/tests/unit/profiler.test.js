'use strict'

const test = require('brittle')
const { decodeCoreKey, collectStats, formatStats, formatSummary } = require('../../lib/profiler')
const IdEnc = require('hypercore-id-encoding')

test('profiler module exports', async t => {
  t.ok(typeof decodeCoreKey === 'function', 'decodeCoreKey is a function')
  t.ok(typeof collectStats === 'function', 'collectStats is a function')
  t.ok(typeof formatStats === 'function', 'formatStats is a function')
  t.ok(typeof formatSummary === 'function', 'formatSummary is a function')
})

// --- decodeCoreKey ---

test('decodeCoreKey - Buffer passthrough', async t => {
  const buf = Buffer.alloc(32, 0xab)
  const result = decodeCoreKey(buf)
  t.ok(Buffer.isBuffer(result), 'returns a Buffer')
  t.ok(result.equals(buf), 'returns the same buffer')
})

test('decodeCoreKey - object with data array', async t => {
  const original = Buffer.alloc(32, 0xcd)
  const obj = { data: Array.from(original) }
  const result = decodeCoreKey(obj)
  t.ok(Buffer.isBuffer(result), 'returns a Buffer')
  t.ok(result.equals(original), 'decodes correctly from data array')
})

test('decodeCoreKey - z32 string', async t => {
  const buf = Buffer.alloc(32, 0xef)
  const encoded = IdEnc.normalize(buf)
  const result = decodeCoreKey(encoded)
  t.ok(Buffer.isBuffer(result), 'returns a Buffer')
  t.ok(result.equals(buf), 'decodes z32 string correctly')
})

// --- collectStats ---

function createMockSwarmStats () {
  return {
    dhtStats: {
      udxBytesReceived: 1048576,
      udxBytesTransmitted: 4096,
      udxPacketsReceived: 1000,
      udxPacketsTransmitted: 50,
      udxPacketsDropped: 2,
      isFirewalled: false
    },
    connects: {
      client: { attempted: 3, opened: 2, closed: 1 }
    },
    getRTOCountAcrossAllStreams: () => 0,
    getFastRecoveriesAcrossAllStreams: () => 1,
    getRetransmitsAcrossAllStreams: () => 3
  }
}

function createMockHypercoreStats () {
  return { totalHotswaps: 5 }
}

function createMockBlobCore () {
  const key = Buffer.alloc(32, 0x01)
  return {
    contiguousLength: 100,
    length: 120,
    peers: [{
      remotePublicKey: key,
      remoteLength: 120,
      remoteContiguousLength: 115
    }]
  }
}

test('collectStats - returns structured snapshot', async t => {
  const sw = createMockSwarmStats()
  const hc = createMockHypercoreStats()
  const core = createMockBlobCore()

  const stats = collectStats(sw, hc, core, 10)

  t.is(stats.elapsedSec, 10)

  t.is(stats.network.bytesRx, 1048576)
  t.is(stats.network.bytesTx, 4096)
  t.is(stats.network.packetsRx, 1000)
  t.is(stats.network.packetsTx, 50)
  t.is(stats.network.packetsDropped, 2)
  t.ok(Math.abs(stats.network.rxPerSec - 104857.6) < 0.01, 'rxPerSec')
  t.ok(Math.abs(stats.network.txPerSec - 409.6) < 0.01, 'txPerSec')

  t.is(stats.connection.firewalled, false)
  t.is(stats.connection.blobPeers, 1)
  t.is(stats.connection.attempted, 3)
  t.is(stats.connection.opened, 2)
  t.is(stats.connection.closed, 1)
  t.is(stats.connection.rtos, 0)
  t.is(stats.connection.fastRecoveries, 1)
  t.is(stats.connection.retransmits, 3)

  t.is(stats.hypercore.contiguousLength, 100)
  t.is(stats.hypercore.length, 120)
  t.is(stats.hypercore.hotswaps, 5)

  t.is(stats.peers.length, 1)
  t.is(stats.peers[0].remoteLength, 120)
  t.is(stats.peers[0].remoteContiguous, 115)
})

test('collectStats - handles zero elapsed', async t => {
  const sw = createMockSwarmStats()
  const hc = createMockHypercoreStats()
  const core = createMockBlobCore()

  const stats = collectStats(sw, hc, core, 0)
  t.is(stats.network.rxPerSec, 0, 'no division by zero')
  t.is(stats.network.txPerSec, 0, 'no division by zero')
})

test('collectStats - handles no peers', async t => {
  const sw = createMockSwarmStats()
  const hc = createMockHypercoreStats()
  const core = { contiguousLength: 0, length: 0, peers: [] }

  const stats = collectStats(sw, hc, core, 5)
  t.is(stats.peers.length, 0)
  t.is(stats.connection.blobPeers, 0)
})

// --- formatStats ---

test('formatStats - contains expected sections', async t => {
  const stats = {
    elapsedSec: 12.5,
    network: {
      bytesRx: 500000,
      bytesTx: 2000,
      rxPerSec: 40000,
      txPerSec: 160,
      packetsRx: 500,
      packetsTx: 20,
      packetsDropped: 0
    },
    connection: {
      firewalled: true,
      blobPeers: 2,
      attempted: 4,
      opened: 3,
      closed: 1,
      rtos: 0,
      fastRecoveries: 0,
      retransmits: 0
    },
    hypercore: {
      contiguousLength: 50,
      length: 60,
      hotswaps: 0
    },
    peers: [
      {
        key: 'o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4',
        remoteLength: 60,
        remoteContiguous: 55
      }
    ]
  }

  const output = formatStats(stats)

  t.ok(output.includes('12.5s elapsed'), 'has elapsed')
  t.ok(output.includes('Network (UDX)'), 'has network section')
  t.ok(output.includes('Connection'), 'has connection section')
  t.ok(output.includes('Hypercore'), 'has hypercore section')
  t.ok(output.includes('Firewalled: true'), 'has firewall status')
  t.ok(output.includes('Blob peers: 2'), 'has peer count')
  t.ok(output.includes('50 / 60'), 'has contiguous/length')
  t.ok(output.includes('o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4o4'), 'has peer key')
  t.ok(output.includes('remote=55/60'), 'has peer remote info')
})

test('formatStats - no peers section when empty', async t => {
  const stats = {
    elapsedSec: 1,
    network: {
      bytesRx: 0,
      bytesTx: 0,
      rxPerSec: 0,
      txPerSec: 0,
      packetsRx: 0,
      packetsTx: 0,
      packetsDropped: 0
    },
    connection: {
      firewalled: false,
      blobPeers: 0,
      attempted: 0,
      opened: 0,
      closed: 0,
      rtos: 0,
      fastRecoveries: 0,
      retransmits: 0
    },
    hypercore: {
      contiguousLength: 0,
      length: 0,
      hotswaps: 0
    },
    peers: []
  }

  const output = formatStats(stats)
  t.absent(output.includes('Peers:'), 'no peers section')
})

// --- formatSummary ---

test('formatSummary - contains expected fields', async t => {
  const output = formatSummary({
    modelPath: 'test/model.gguf',
    totalBytes: 1073741824,
    totalBlocks: 16384,
    metadataSec: 1.5,
    transferSec: 45.2,
    avgSpeed: 23756800,
    totalSec: 46.7
  })

  t.ok(output.includes('FINAL SUMMARY'), 'has header')
  t.ok(output.includes('test/model.gguf'), 'has model path')
  t.ok(output.includes('16384 blocks'), 'has block count')
  t.ok(output.includes('1.50s'), 'has metadata time')
  t.ok(output.includes('45.20s'), 'has transfer time')
  t.ok(output.includes('46.70s'), 'has total time')
})
