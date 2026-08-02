'use strict'

const test = require('brittle')
const tmp = require('test-tmp')
const path = require('#path')
const Corestore = require('corestore')
const Hyperblobs = require('hyperblobs')
const QVACRegistryClient = require('../../lib/client')

const PAYLOAD_BYTES = 8 * 1024 * 1024
const CANCEL_AFTER_BLOCKS = 8

function logger() {
  return {
    info() {},
    debug() {},
    warn() {},
    error() {}
  }
}

function cancellation() {
  let onAbort = null
  const signal = {
    aborted: false,
    addEventListener(event, listener) {
      if (event === 'abort') onAbort = listener
    }
  }

  return {
    signal,
    abort() {
      signal.aborted = true
      if (onAbort) onAbort()
    }
  }
}

async function countBlocks(storage, coreKey, pointer) {
  const store = new Corestore(storage)
  const core = store.get({ key: coreKey })
  await core.ready()

  let blocks = 0
  for (
    let index = pointer.blockOffset;
    index < pointer.blockOffset + pointer.blockLength;
    index++
  ) {
    if (await core.has(index)) blocks++
  }

  await core.close()
  await store.close()
  return blocks
}

test('cancelled download leaves no durable blocks after reopen', async (t) => {
  const root = await tmp(t)
  const writerStorage = path.join(root, 'writer')
  const readerStorage = path.join(root, 'reader')
  const outputFile = path.join(root, 'partial.gguf')

  const writerStore = new Corestore(writerStorage)
  const writerCore = writerStore.get({ name: 'blobs' })
  await writerCore.ready()
  const coreKey = writerCore.key
  const writerBlobs = new Hyperblobs(writerCore)
  await writerBlobs.ready()
  const pointer = await writerBlobs.put(Buffer.alloc(PAYLOAD_BYTES, 1))

  const readerStore = new Corestore(readerStorage)
  const readerCore = readerStore.get({ key: coreKey })
  await readerCore.ready()
  const readerBlobs = new Hyperblobs(readerCore)
  await readerBlobs.ready()

  const writerReplication = writerStore.replicate(true)
  const readerReplication = readerStore.replicate(false)
  writerReplication.pipe(readerReplication).pipe(writerReplication)

  const client = Object.create(QVACRegistryClient.prototype)
  client.logger = logger()
  client.hyperswarm = {
    join() {},
    flush() {
      return Promise.resolve()
    }
  }
  client._ensureMetadata = () => Promise.resolve()
  client.getModel = () =>
    Promise.resolve({
      name: 'storage-test',
      blobBinding: { coreKey, ...pointer }
    })
  client._getBlobsCore = () => Promise.resolve({ core: readerCore, blobs: readerBlobs })

  const controller = cancellation()
  let downloadedBlocks = 0
  readerCore.on('download', () => {
    downloadedBlocks++
    if (downloadedBlocks === CANCEL_AFTER_BLOCKS) controller.abort()
  })

  await t.exception(
    () =>
      client.downloadModel('models/storage-test.gguf', 's3', {
        outputFile,
        signal: controller.signal,
        maxRetries: 1
      }),
    /Download cancelled/,
    'the download is cancelled while blocks are in flight'
  )

  readerReplication.destroy()
  writerReplication.destroy()
  await readerStore.close()
  await writerBlobs.close()
  await writerCore.close()
  await writerStore.close()

  t.ok(downloadedBlocks > CANCEL_AFTER_BLOCKS, 'in-flight blocks arrived after cancellation')
  t.is(
    await countBlocks(readerStorage, coreKey, pointer),
    0,
    'no downloaded blocks remain after reopening the corestore'
  )
})

test('drain timeout logs remaining peer counters with real Hypercore peers', async (t) => {
  const root = await tmp(t)
  const writerStorage = path.join(root, 'writer')
  const readerStorage = path.join(root, 'reader')
  const outputFile = path.join(root, 'partial.gguf')

  const writerStore = new Corestore(writerStorage)
  const writerCore = writerStore.get({ name: 'blobs' })
  await writerCore.ready()
  const coreKey = writerCore.key
  const writerBlobs = new Hyperblobs(writerCore)
  await writerBlobs.ready()
  const pointer = await writerBlobs.put(Buffer.alloc(PAYLOAD_BYTES, 1))

  const readerStore = new Corestore(readerStorage)
  const readerCore = readerStore.get({ key: coreKey })
  await readerCore.ready()
  const readerBlobs = new Hyperblobs(readerCore)
  await readerBlobs.ready()

  const writerReplication = writerStore.replicate(true)
  const readerReplication = readerStore.replicate(false)
  writerReplication.pipe(readerReplication).pipe(writerReplication)

  // Hold verify long enough that drain hits the best-effort timeout while
  // peer.dataProcessing is still nonzero.
  const VERIFY_HOLD_MS = 250
  const originalVerify = readerCore.core.verify.bind(readerCore.core)
  readerCore.core.verify = async function (...args) {
    await new Promise((resolve) => setTimeout(resolve, VERIFY_HOLD_MS))
    return originalVerify(...args)
  }

  const warnings = []
  const client = Object.create(QVACRegistryClient.prototype)
  client.logger = {
    info() {},
    debug() {},
    warn(msg, data) {
      warnings.push({ msg, data })
    },
    error() {}
  }
  client._inflightDrainTimeoutMs = 40
  client._inflightDrainPollMs = 5
  client.hyperswarm = {
    join() {},
    flush() {
      return Promise.resolve()
    }
  }
  client._ensureMetadata = () => Promise.resolve()
  client.getModel = () =>
    Promise.resolve({
      name: 'storage-timeout-test',
      blobBinding: { coreKey, ...pointer }
    })
  client._getBlobsCore = () => Promise.resolve({ core: readerCore, blobs: readerBlobs })

  const controller = cancellation()
  let downloadedBlocks = 0
  readerCore.on('download', () => {
    downloadedBlocks++
    if (downloadedBlocks === CANCEL_AFTER_BLOCKS) controller.abort()
  })

  await t.exception(
    () =>
      client.downloadModel('models/storage-timeout-test.gguf', 's3', {
        outputFile,
        signal: controller.signal,
        maxRetries: 1
      }),
    /Download cancelled/,
    'the download is cancelled while verify is still held'
  )

  readerReplication.destroy()
  writerReplication.destroy()
  await readerStore.close()
  await writerBlobs.close()
  await writerCore.close()
  await writerStore.close()

  const timeoutWarning = warnings.find((entry) =>
    entry.msg.includes('Timed out waiting for in-flight blob blocks')
  )
  t.ok(timeoutWarning, 'drain timeout is logged against real peers')
  t.ok(Array.isArray(timeoutWarning.data.peers), 'timeout warning includes peer counters')
  t.ok(
    timeoutWarning.data.peers.some((peer) => peer.inflight > 0 || peer.dataProcessing > 0),
    'logged counters show work still outstanding at timeout'
  )
  t.ok(downloadedBlocks >= CANCEL_AFTER_BLOCKS, 'cancellation fired after blocks started arriving')
})
