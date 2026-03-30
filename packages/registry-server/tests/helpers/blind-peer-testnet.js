'use strict'

const setupTestnet = require('hyperdht/testnet')
const Hyperswarm = require('hyperswarm')
const IdEnc = require('hypercore-id-encoding')
const BlindPeer = require('blind-peer')
const { createTempStorage } = require('./test-utils')

async function createBlindPeerTestnet (t, opts = {}) {
  const peers = opts.peers || 1
  const testnet = await setupTestnet()
  t.teardown(async () => {
    await testnet.destroy()
  })

  const instances = []

  for (let i = 0; i < peers; i++) {
    const storage = await createTempStorage(t)
    const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
    const blindPeer = new BlindPeer(storage, { swarm })
    await blindPeer.ready()
    await blindPeer.listen()

    instances.push({
      peer: blindPeer,
      swarm,
      storage,
      publicKey: IdEnc.normalize(blindPeer.publicKey)
    })

    t.teardown(async () => {
      await blindPeer.close().catch(() => {})
      await swarm.destroy().catch(() => {})
    })
  }

  return {
    bootstrap: testnet.bootstrap,
    peers: instances,
    blindPeerKeys: instances.map(instance => instance.publicKey)
  }
}

module.exports = {
  createBlindPeerTestnet
}
