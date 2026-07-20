'use strict'

const test = require('brittle')
const tmp = require('test-tmp')
const fs = require('#fs')
const path = require('#path')
const { withRetry } = require('../../utils/retry')

// Builds a QVACRegistryClient instance WITHOUT running the constructor (which
// would open a real Corestore and join a real swarm). Only the collaborators
// that downloadModel touches are stubbed, so the real retry path runs.
function makeClient () {
  const QVACRegistryClient = require('../../lib/client')
  const client = Object.create(QVACRegistryClient.prototype)

  const events = []
  client._events = events

  client.logger = { info () {}, debug () {}, warn () {}, error () {} }

  const core = {
    discoveryKey: Buffer.alloc(32),
    findingPeers () { events.push('findingPeers'); return () => {} },
    async update () { events.push('core.update') },
    download () { return { destroy () {} } },
    async close () {},
    on () {},
    off () {}
  }
  const blobs = { async close () {} }
  client._core = core

  client.hyperswarm = {
    suspended: false,
    join () { events.push('swarm.join') },
    async flush () {}
  }

  client._ensureMetadata = async () => {}
  client.getModel = async () => ({
    name: 'tiny-model',
    blobBinding: {
      coreKey: Buffer.alloc(32),
      blockOffset: 0,
      blockLength: 10,
      byteLength: 1000
    }
  })
  client._getBlobsCore = async () => ({ core, blobs })
  client._clearBlobBlocks = async () => {}

  return client
}

function requestTimeout () {
  const err = new Error('request timed out waiting for peers')
  err.code = 'REQUEST_TIMEOUT'
  return err
}

const PARTIAL = Buffer.alloc(256, 1)
const COMPLETE = Buffer.alloc(1000, 2)

// The resume speedup comes from the core's cached blocks, not the output file
// (which `_streamBlobToFile` truncates and re-streams each attempt). The real
// invariant is that cached blocks are not cleared until the download succeeds.
test('downloadModel keeps cached blocks across a REQUEST_TIMEOUT retry', async t => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'model.gguf')

  const client = makeClient()
  let clearCalls = 0
  let clearsBeforeRetrySucceeded = null
  client._clearBlobBlocks = async () => { clearCalls++ }

  let attempt = 0
  client._streamBlobToFile = async (blobs, core, pointer, filePath) => {
    attempt++
    if (attempt === 1) throw requestTimeout()
    clearsBeforeRetrySucceeded = clearCalls
    await fs.promises.writeFile(filePath, COMPLETE)
  }

  await client.downloadModel('models/tiny.gguf', 's3', { outputFile, maxRetries: 3 })

  t.is(attempt, 2, 'streamBlobToFile retried exactly once after REQUEST_TIMEOUT')
  t.is(clearsBeforeRetrySucceeded, 0, 'cached blocks were not cleared before the retry')
  t.is(clearCalls, 1, 'cached blocks cleared once, only after success')
})

test('downloadModel waits for the swarm to resume before retrying', async t => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'model.gguf')

  const client = makeClient()
  // Start backgrounded; foreground shortly after the first failure.
  let suspended = true
  Object.defineProperty(client.hyperswarm, 'suspended', { get () { return suspended } })

  let attempt = 0
  client._streamBlobToFile = async (blobs, core, pointer, filePath) => {
    attempt++
    client._events.push('attempt-' + attempt)
    if (attempt === 1) {
      setTimeout(() => { suspended = false; client._events.push('resumed') }, 100)
      throw requestTimeout()
    }
    await fs.promises.writeFile(filePath, COMPLETE)
  }

  await client.downloadModel('models/tiny.gguf', 's3', { outputFile, maxRetries: 3 })

  const ev = client._events
  t.is(attempt, 2, 'retried after the swarm resumed')
  t.ok(ev.includes('resumed'), 'swarm resumed during the wait')
  t.ok(
    ev.indexOf('resumed') < ev.indexOf('attempt-2'),
    'retry waited until the swarm resumed (did not burn the attempt while suspended)'
  )
})

test('downloadModel waits for a replication peer before retrying', async t => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'model.gguf')

  const client = makeClient()
  // No peers initially (network down); a peer shows up shortly after the failure.
  client._core.peers = []

  let attempt = 0
  client._streamBlobToFile = async (blobs, core, pointer, filePath) => {
    attempt++
    client._events.push('attempt-' + attempt)
    if (attempt === 1) {
      setTimeout(() => { core.peers.push({}); client._events.push('peer-connected') }, 100)
      throw requestTimeout()
    }
    await fs.promises.writeFile(filePath, COMPLETE)
  }

  await client.downloadModel('models/tiny.gguf', 's3', { outputFile, maxRetries: 3 })

  const ev = client._events
  t.is(attempt, 2, 'retried after a peer reconnected')
  t.ok(ev.includes('peer-connected'), 'a peer reconnected during the wait')
  t.ok(
    ev.indexOf('peer-connected') < ev.indexOf('attempt-2'),
    'retry waited until a peer was replicating the core'
  )
})

test('downloadModel re-establishes peers before retrying after REQUEST_TIMEOUT', async t => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'model.gguf')

  const client = makeClient()
  let attempt = 0

  client._streamBlobToFile = async (blobs, core, pointer, filePath) => {
    attempt++
    client._events.push('attempt-' + attempt)
    if (attempt === 1) {
      await fs.promises.writeFile(filePath, PARTIAL)
      throw requestTimeout()
    }
    await fs.promises.writeFile(filePath, COMPLETE)
  }

  await client.downloadModel('models/tiny.gguf', 's3', { outputFile, maxRetries: 3 })

  const ev = client._events
  const firstAttempt = ev.indexOf('attempt-1')
  const secondAttempt = ev.indexOf('attempt-2')
  t.ok(secondAttempt > firstAttempt, 'a second attempt happened')

  const between = ev.slice(firstAttempt + 1, secondAttempt)
  const reconnected =
    between.includes('core.update') ||
    between.includes('findingPeers') ||
    between.includes('swarm.join')
  t.ok(
    reconnected,
    'peer re-discovery / core re-sync runs and is awaited before the retry'
  )
})

test('downloadModel gives up after maxRetries on persistent REQUEST_TIMEOUT', async t => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'model.gguf')

  const client = makeClient()
  let attempt = 0

  client._streamBlobToFile = async () => {
    attempt++
    throw requestTimeout()
  }

  await t.exception(
    () => client.downloadModel('models/tiny.gguf', 's3', { outputFile, maxRetries: 2 }),
    /request timed out/,
    'rejects after exhausting retries'
  )
  t.is(attempt, 2, 'attempted exactly maxRetries times')
})

test('downloadModel aborts the reconnect wait when the signal is cancelled', async t => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'model.gguf')

  const client = makeClient()
  // Swarm never resumes, so without a cancel the reconnect wait would block up
  // to RESUME_WAIT_MAX_MS before the next attempt.
  Object.defineProperty(client.hyperswarm, 'suspended', { get () { return true } })

  const signal = { aborted: false }
  let attempt = 0
  client._streamBlobToFile = async (blobs, core, pointer, filePath) => {
    attempt++
    if (attempt === 1) {
      // Cancel while _reconnectCore is waiting for the (never-resuming) swarm.
      setTimeout(() => { signal.aborted = true }, 50)
      throw requestTimeout()
    }
    await fs.promises.writeFile(filePath, COMPLETE)
  }

  await t.exception(
    () => client.downloadModel('models/tiny.gguf', 's3', { outputFile, maxRetries: 3, signal }),
    /Download cancelled/,
    'cancel during the reconnect wait rejects promptly instead of blocking on the swarm'
  )
  t.is(attempt, 1, 'no second attempt started after the cancel')
})

// Locks the generic retry contract the download path relies on.
test('withRetry retries only listed codes and stays bounded', async t => {
  let calls = 0
  await t.exception(
    () => withRetry(
      async () => { calls++; throw requestTimeout() },
      { maxRetries: 3, retryCodes: ['REQUEST_TIMEOUT'] }
    ),
    /request timed out/
  )
  t.is(calls, 3, 'retried up to maxRetries')

  let nonRetriable = 0
  await t.exception(
    () => withRetry(
      async () => { nonRetriable++; const e = new Error('nope'); e.code = 'OTHER'; throw e },
      { maxRetries: 3, retryCodes: ['REQUEST_TIMEOUT'] }
    ),
    /nope/
  )
  t.is(nonRetriable, 1, 'non-retriable error propagates immediately')
})
