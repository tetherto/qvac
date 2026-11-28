'use strict'

const test = require('brittle')
const tmp = require('test-tmp')
const path = require('path')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const IdEnc = require('hypercore-id-encoding')
const ReseedTracker = require('../../lib/reseed-tracker')

const quietLogger = { info () {}, warn () {}, error () {} }
const BLOCKS = 10

async function setup (t, peerKeyPair) {
  const dir = await tmp(t)
  const writer = new Hypercore(path.join(dir, 'writer'))
  await writer.ready()
  for (let i = 0; i < BLOCKS; i++) await writer.append(Buffer.from('block-' + i))

  const peer = new Hypercore(path.join(dir, 'peer'), writer.key)
  await peer.ready()

  const s1 = writer.replicate(true, { keyPair: crypto.keyPair() })
  const s2 = peer.replicate(false, { keyPair: peerKeyPair })
  s1.pipe(s2).pipe(s1)

  t.teardown(async () => {
    s1.destroy()
    s2.destroy()
    await peer.close()
    await writer.close()
  })

  while (!writer.replicator.peers.length || !peer.replicator.peers.length) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  return { writer, peer }
}

test('ReseedTracker ignores a non-blind peer that announces blocks it does not have', async (t) => {
  const blindPeerKeyPair = crypto.keyPair()
  const { writer, peer } = await setup(t, crypto.keyPair())

  // Announce the full range without holding any block.
  peer.replicator.peers[0].wireRange.send({ drop: false, start: 0, length: writer.length })
  await new Promise((resolve) => setTimeout(resolve, 100))

  t.is(peer.contiguousLength, 0, 'peer holds no blocks')
  t.is(writer.replicator.peers[0].remoteContiguousLength, BLOCKS, 'writer sees the announced range')

  const tracker = new ReseedTracker([IdEnc.normalize(blindPeerKeyPair.publicKey)], quietLogger)
  tracker.trackCore(writer)

  await t.exception(
    tracker.waitForComplete({ pollInterval: 50, progressTimeout: 500 }),
    /stalled/,
    'tracker does not report completion'
  )
  tracker.destroy()
})

test('ReseedTracker completes once a configured blind peer has every block', async (t) => {
  const blindPeerKeyPair = crypto.keyPair()
  const { writer, peer } = await setup(t, blindPeerKeyPair)

  await peer.download({ start: 0, end: writer.length }).done()

  const tracker = new ReseedTracker([IdEnc.normalize(blindPeerKeyPair.publicKey)], quietLogger)
  tracker.trackCore(writer)

  await t.execution(tracker.waitForComplete({ pollInterval: 50, progressTimeout: 2000 }))
  tracker.destroy()
})
