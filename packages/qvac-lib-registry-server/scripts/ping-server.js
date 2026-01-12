'use strict'

const os = require('os')
const path = require('path')
const RegistryConfig = require('../lib/config')
const { connectToRegistry } = require('./utils/rpc-client')

const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS, 10) || 30000

async function pingServer () {
  const config = new RegistryConfig()
  const tmpStorage = path.join(os.tmpdir(), `qvac-ping-${Date.now()}`)

  console.log('Connecting to registry server...')
  console.log(`Timeout: ${TIMEOUT_MS}ms`)

  let connection = null

  try {
    connection = await connectToRegistry({
      config,
      storage: tmpStorage,
      timeout: TIMEOUT_MS,
      logger: {
        info: (...args) => console.log(...args),
        warn: (...args) => console.warn(...args),
        debug: () => {} // Suppress debug output
      }
    })

    console.log(`Connected to peer: ${connection.peerKey}`)

    const response = await connection.rpc.request('ping', {})

    console.log('\n--- Ping Response ---')
    console.log(`Role: ${response.role}`)
    console.log(`Is Indexer: ${response.isIndexer}`)
    console.log(`Timestamp: ${new Date(response.timestamp).toISOString()}`)
    console.log('--- Server is available ---')

    return response
  } catch (err) {
    console.error(`\nFailed to ping server: ${err.message}`)
    process.exit(1)
  } finally {
    if (connection) {
      await connection.cleanup()
    }
  }
}

if (require.main === module) {
  pingServer().catch(err => {
    console.error('Fatal error:', err.message)
    process.exit(1)
  })
}

module.exports = { pingServer }
