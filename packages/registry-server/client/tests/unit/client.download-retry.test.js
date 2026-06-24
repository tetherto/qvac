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

test('downloadModel preserves the partial across a REQUEST_TIMEOUT retry', async t => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'model.gguf')

  const client = makeClient()
  let attempt = 0
  let partialPresentOnRetry = null

  client._streamBlobToFile = async (blobs, core, pointer, filePath) => {
    attempt++
    client._events.push('attempt-' + attempt)
    if (attempt === 1) {
      await fs.promises.writeFile(filePath, PARTIAL)
      throw requestTimeout()
    }
    // Second attempt: observe whether the partial written above survived.
    try {
      const st = await fs.promises.stat(filePath)
      partialPresentOnRetry = st.size >= PARTIAL.length
    } catch {
      partialPresentOnRetry = false
    }
    await fs.promises.writeFile(filePath, COMPLETE)
  }

  await client.downloadModel('models/tiny.gguf', 's3', { outputFile, maxRetries: 3 })

  t.is(attempt, 2, 'streamBlobToFile retried exactly once after REQUEST_TIMEOUT')
  t.ok(
    partialPresentOnRetry,
    'partial on disk is preserved going into the retry (not unlinked)'
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
