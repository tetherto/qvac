'use strict'

const os = require('os')
const path = require('path')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const IdEnc = require('hypercore-id-encoding')
const goodbye = require('graceful-goodbye')
const RegistryConfig = require('../lib/config')

const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS, 10) || 30000
const WAIT_FOR_PEERS_MS = parseInt(process.env.WAIT_FOR_PEERS_MS, 10) || 5000

function parseArgs () {
  const args = process.argv.slice(2)
  const result = { key: null }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--key' && args[i + 1]) {
      result.key = args[i + 1]
      i++
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node scripts/check-peers.js [--key <hypercore-key>]

Options:
  --key <key>   Hypercore key to check (defaults to QVAC_REGISTRY_CORE_KEY from env)
  --help, -h    Show this help message

Environment:
  TIMEOUT_MS         Connection timeout in ms (default: 30000)
  WAIT_FOR_PEERS_MS  Time to wait for peers after first connection (default: 5000)
`)
      process.exit(0)
    }
  }

  return result
}

async function checkPeers (options = {}) {
  const config = new RegistryConfig()
  const key = options.key || config.getRegistryCoreKey()

  if (!key) {
    console.error('Error: No key provided. Use --key <key> or set QVAC_REGISTRY_CORE_KEY')
    process.exit(1)
  }

  const keyBuffer = IdEnc.decode(key)
  const keyNormalized = IdEnc.normalize(keyBuffer)

  console.log(`Checking peers for core: ${keyNormalized}`)
  console.log(`Timeout: ${TIMEOUT_MS}ms, Wait for peers: ${WAIT_FOR_PEERS_MS}ms\n`)

  const tmpStorage = path.join(os.tmpdir(), `qvac-check-peers-${Date.now()}`)
  const store = new Corestore(tmpStorage)
  const swarm = new Hyperswarm()

  goodbye(async () => {
    await swarm.destroy()
    await store.close()
  })

  await store.ready()

  const core = store.get({ key: keyBuffer })
  await core.ready()

  console.log(`Discovery key: ${IdEnc.normalize(core.discoveryKey)}`)
  console.log('Joining swarm...\n')

  let connectionCount = 0
  const connectedPeers = new Map()

  swarm.on('connection', (conn, peerInfo) => {
    const peerKey = IdEnc.normalize(peerInfo.publicKey)
    connectionCount++
    connectedPeers.set(peerKey, { conn, peerInfo })
    console.log(`Connected to peer: ${peerKey}`)
    store.replicate(conn)
  })

  swarm.join(core.discoveryKey)

  const timeoutPromise = new Promise((resolve, reject) => {
    setTimeout(() => {
      if (connectionCount === 0) {
        reject(new Error('No peers found within timeout'))
      } else {
        resolve()
      }
    }, TIMEOUT_MS)
  })

  const firstConnectionPromise = new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      if (connectionCount > 0) {
        clearInterval(checkInterval)
        resolve()
      }
    }, 100)
  })

  try {
    await Promise.race([firstConnectionPromise, timeoutPromise])

    // Wait additional time to discover more peers
    console.log(`\nWaiting ${WAIT_FOR_PEERS_MS}ms for more peers...`)
    await new Promise(resolve => setTimeout(resolve, WAIT_FOR_PEERS_MS))

    // Force sync with peers - wait for acknowledgment
    console.log('Syncing with peers...')
    await core.update({ wait: true })

    // Try to get the actual length by requesting info from peers
    // This forces peers to send their latest state
    if (core.length > 0) {
      await core.get(core.length - 1).catch(() => {})
    }

    // Wait a bit more for async contiguous length updates to propagate
    // Hypercore's contiguousLength lags by 1-2 blocks and updates within ~100ms
    console.log('Waiting for contiguous length updates...')
    await new Promise(resolve => setTimeout(resolve, 500))
    await core.update()

    // Check length after sync
    const lengthAfterSync = core.length

    console.log('\n--- Peer Status ---')
    console.log(`Local length (after sync): ${lengthAfterSync}`)
    console.log(`Local contiguous length: ${core.contiguousLength}`)
    const localGap = lengthAfterSync - core.contiguousLength
    if (localGap > 0) {
      console.log(`Local gap: ${localGap} blocks (expected: 1-2 blocks lag due to async updates)`)
    }
    console.log(`Local byte length: ${core.byteLength}`)
    console.log(`Total connections: ${connectionCount}`)
    console.log(`Core peers: ${core.peers.length}\n`)

    if (core.peers.length === 0) {
      console.log('No peer info available yet (peers may still be syncing protocol)')
    } else {
      console.log('Peer details:')
      for (const peer of core.peers) {
        const peerKey = peer.remotePublicKey
          ? IdEnc.normalize(peer.remotePublicKey)
          : 'unknown'

        console.log(`\n  Peer: ${peerKey}`)
        console.log(`    Remote length: ${peer.remoteLength}`)
        console.log(`    Remote contiguous: ${peer.remoteContiguousLength}`)
        console.log(`    Remote fork: ${peer.remoteFork}`)

        const lengthDiff = core.length - peer.remoteLength
        if (lengthDiff !== 0) {
          const status = lengthDiff > 0 ? 'behind' : 'ahead'
          console.log(`    Sync status: ${Math.abs(lengthDiff)} blocks ${status}`)
        } else {
          console.log('    Sync status: in sync')
        }
      }
    }

    console.log('\n--- Done ---')
  } catch (err) {
    console.error(`\nError: ${err.message}`)
    process.exit(1)
  } finally {
    await swarm.destroy()
    await store.close()
  }
}

if (require.main === module) {
  const args = parseArgs()
  checkPeers(args).catch(err => {
    console.error('Fatal error:', err.message)
    process.exit(1)
  })
}

module.exports = { checkPeers }
