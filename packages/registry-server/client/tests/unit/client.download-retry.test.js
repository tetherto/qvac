'use strict'

const test = require('brittle')
const tmp = require('test-tmp')
const fs = require('#fs')
const path = require('#path')
const { withRetry } = require('../../utils/retry')

// Forwards the client's own log lines into TAP output when a test passes `t`,
// so the run shows which production branches actually executed.
function makeLogger(t) {
  const emit = (level, msg, data) => {
    if (!t) return
    let detail = ''
    if (data instanceof Error) detail = ` ${data.message}`
    else if (data) detail = ` ${JSON.stringify(data).slice(0, 120)}`
    t.comment(`[${level}] ${msg}${detail}`)
  }

  return {
    info(msg, data) {
      emit('info', msg, data)
    },
    debug(msg, data) {
      emit('debug', msg, data)
    },
    warn(msg, data) {
      emit('warn', msg, data)
    },
    error(msg, data) {
      emit('error', msg, data)
    }
  }
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

// Builds a QVACRegistryClient instance WITHOUT running the constructor (which
// would open a real Corestore and join a real swarm). Only the collaborators
// that downloadModel touches are stubbed, so the real retry path runs.
function makeClient(t) {
  const QVACRegistryClient = require('../../lib/client')
  const client = Object.create(QVACRegistryClient.prototype)

  const events = []
  client._events = events

  client.logger = makeLogger(t)

  const core = {
    discoveryKey: Buffer.alloc(32),
    findingPeers() {
      events.push('findingPeers')
      return () => {}
    },
    // lunte-disable-next-line require-await
    async update() {
      events.push('core.update')
    },
    download() {
      return { destroy() {} }
    },
    // lunte-disable-next-line require-await
    async close() {},
    on() {},
    off() {}
  }
  const blobs = {
    // lunte-disable-next-line require-await
    async close() {},
    createReadStream() {
      return client._stream
    }
  }
  client._core = core
  client._blobs = blobs
  client._stream = fakeStream()

  client.hyperswarm = {
    suspended: false,
    join() {
      events.push('swarm.join')
    },
    // lunte-disable-next-line require-await
    async flush() {}
  }

  // lunte-disable-next-line require-await
  client._ensureMetadata = async () => {}
  // lunte-disable-next-line require-await
  client.getModel = async () => ({
    name: 'tiny-model',
    blobBinding: {
      coreKey: Buffer.alloc(32),
      blockOffset: 0,
      blockLength: 10,
      byteLength: 1000
    }
  })
  // lunte-disable-next-line require-await
  client._getBlobsCore = async () => ({ core, blobs })
  // lunte-disable-next-line require-await
  client._clearBlobBlocks = async () => {}

  return client
}

// Stands in for the hyperblobs read stream; emit() resolves once the release
// handlers it triggered have settled.
function fakeStream() {
  const handlers = {}
  return {
    once(event, fn) {
      ;(handlers[event] = handlers[event] || []).push(fn)
    },
    emit(event) {
      const fns = handlers[event] || []
      handlers[event] = []
      return Promise.all(fns.map((fn) => fn()))
    }
  }
}

function requestTimeout() {
  const err = new Error('request timed out waiting for peers')
  err.code = 'REQUEST_TIMEOUT'
  return err
}

const PARTIAL = Buffer.alloc(256, 1)
const COMPLETE = Buffer.alloc(1000, 2)

// The resume speedup comes from the core's cached blocks, not the output file
// (which `_streamBlobToFile` truncates and re-streams each attempt). The real
// invariant is that cached blocks are not cleared until the download succeeds.
test('downloadModel keeps cached blocks across a REQUEST_TIMEOUT retry', async (t) => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'model.gguf')

  const client = makeClient()
  let clearCalls = 0
  let clearsBeforeRetrySucceeded = null
  // lunte-disable-next-line require-await
  client._clearBlobBlocks = async () => {
    clearCalls++
  }

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

test('downloadModel waits for the swarm to resume before retrying', async (t) => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'model.gguf')

  const client = makeClient()
  // Start backgrounded; foreground shortly after the first failure.
  let suspended = true
  Object.defineProperty(client.hyperswarm, 'suspended', {
    get() {
      return suspended
    }
  })

  let attempt = 0
  client._streamBlobToFile = async (blobs, core, pointer, filePath) => {
    attempt++
    client._events.push('attempt-' + attempt)
    if (attempt === 1) {
      setTimeout(() => {
        suspended = false
        client._events.push('resumed')
      }, 100)
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

test('downloadModel waits for a replication peer before retrying', async (t) => {
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
      setTimeout(() => {
        core.peers.push({})
        client._events.push('peer-connected')
      }, 100)
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

test('downloadModel re-establishes peers before retrying after REQUEST_TIMEOUT', async (t) => {
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
  t.ok(reconnected, 'peer re-discovery / core re-sync runs and is awaited before the retry')
})

test('downloadModel gives up after maxRetries on persistent REQUEST_TIMEOUT', async (t) => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'model.gguf')

  const client = makeClient()
  let attempt = 0

  // lunte-disable-next-line require-await
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

test('downloadModel aborts the reconnect wait when the signal is cancelled', async (t) => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'model.gguf')

  const client = makeClient()
  // Swarm never resumes, so without a cancel the reconnect wait would block up
  // to RESUME_WAIT_MAX_MS before the next attempt.
  Object.defineProperty(client.hyperswarm, 'suspended', {
    get() {
      return true
    }
  })

  const signal = { aborted: false }
  let attempt = 0
  client._streamBlobToFile = async (blobs, core, pointer, filePath) => {
    attempt++
    if (attempt === 1) {
      // Cancel while _reconnectCore is waiting for the (never-resuming) swarm.
      setTimeout(() => {
        signal.aborted = true
      }, 50)
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

test('downloadModel clears cached blocks when the download is cancelled', async (t) => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'model.gguf')

  const client = makeClient(t)
  const clears = []
  client._core.download = () => ({
    destroy() {
      client._events.push('destroy')
      t.comment('step: rangeDownload.destroy() called from the catch path')
    }
  })
  // lunte-disable-next-line require-await
  client._clearBlobBlocks = async (core, start, end) => {
    client._events.push('clear')
    clears.push({ start, end })
    t.comment(`step: _clearBlobBlocks(${start}, ${end}) called`)
  }
  // lunte-disable-next-line require-await
  client._streamBlobToFile = async () => {
    client._events.push('stream')
    t.comment('step: _streamBlobToFile rejecting to force the catch path')
    throw new Error('Download cancelled')
  }

  const started = now()
  await t.exception(
    () => client.downloadModel('models/tiny.gguf', 's3', { outputFile, signal: { aborted: true } }),
    /Download cancelled/,
    'the cancelled download rejects'
  )
  t.comment(`timing: downloadModel cancel+release took ${(now() - started).toFixed(1)}ms`)

  t.is(clears.length, 1, 'partial blocks cleared exactly once on the cancel path')
  t.alike(clears[0], { start: 0, end: 10 }, 'cleared the model block range')
  t.ok(
    client._events.indexOf('stream') < client._events.indexOf('clear'),
    'blocks are cleared after the download is cancelled (in the catch)'
  )
  const destroyedAt = client._events.indexOf('destroy')
  t.ok(
    destroyedAt !== -1 && destroyedAt < client._events.indexOf('clear'),
    'replication is stopped before clearing so blocks are not refetched'
  )
})

test('downloadModel waits for in-flight blocks before clearing after cancel', async (t) => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'model.gguf')

  const client = makeClient(t)
  const peer = { inflight: 1, dataProcessing: 0 }
  client._core.peers = [peer]
  client._core.download = () => ({
    destroy() {
      client._events.push('destroy')
      setTimeout(() => {
        peer.inflight = 0
        client._events.push('drained')
      }, 20)
    }
  })
  // lunte-disable-next-line require-await
  client._clearBlobBlocks = async () => {
    client._events.push('clear')
  }
  // lunte-disable-next-line require-await
  client._streamBlobToFile = async () => {
    throw new Error('Download cancelled')
  }

  await t.exception(
    () => client.downloadModel('models/tiny.gguf', 's3', { outputFile, signal: { aborted: true } }),
    /Download cancelled/,
    'the cancelled download rejects'
  )

  const drainedAt = client._events.indexOf('drained')
  t.ok(
    drainedAt !== -1 && drainedAt < client._events.indexOf('clear'),
    'in-flight blocks drain before the cached range is cleared'
  )
})

test('downloadModel logs remaining peer counters when drain times out', async (t) => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'model.gguf')

  const client = makeClient(t)
  const warnings = []
  const baseWarn = client.logger.warn.bind(client.logger)
  client.logger.warn = (msg, data) => {
    warnings.push({ msg, data })
    baseWarn(msg, data)
  }
  client._inflightDrainTimeoutMs = 30
  client._inflightDrainPollMs = 5
  client._core.peers = [{ inflight: 2, dataProcessing: 1 }]
  client._core.download = () => ({
    destroy() {
      client._events.push('destroy')
    }
  })
  // lunte-disable-next-line require-await
  client._clearBlobBlocks = async () => {
    client._events.push('clear')
  }
  // lunte-disable-next-line require-await
  client._streamBlobToFile = async () => {
    throw new Error('Download cancelled')
  }

  await t.exception(
    () => client.downloadModel('models/tiny.gguf', 's3', { outputFile, signal: { aborted: true } }),
    /Download cancelled/,
    'the cancelled download rejects'
  )

  const timeoutWarning = warnings.find((entry) =>
    entry.msg.includes('Timed out waiting for in-flight blob blocks')
  )
  t.ok(timeoutWarning, 'drain timeout is logged')
  t.alike(
    timeoutWarning.data.peers,
    [{ peer: 0, inflight: 2, dataProcessing: 1 }],
    'timeout warning includes remaining inflight and dataProcessing counters'
  )
  t.ok(client._events.includes('clear'), 'best-effort clear still runs after the timeout')
})

test('downloadModel clears cached blocks when the returned stream is destroyed', async (t) => {
  const client = makeClient(t)
  const clears = []
  client._core.download = () => ({
    destroy() {
      client._events.push('destroy')
      t.comment('step: rangeDownload.destroy() called from the stream release')
    }
  })
  // lunte-disable-next-line require-await
  client._clearBlobBlocks = async (core, start, end) => {
    client._events.push('clear')
    clears.push({ start, end })
    t.comment(`step: _clearBlobBlocks(${start}, ${end}) called`)
  }

  const { artifact } = await client.downloadModel('models/tiny.gguf', 's3')
  t.comment('step: stream artifact returned, release handlers bound')

  t.is(clears.length, 0, 'nothing cleared while the stream is still live')

  // A cancelled consumer destroys the stream, which emits 'close' without 'end'.
  t.comment("step: emitting 'close' without 'end' (consumer destroyed the stream)")
  const started = now()
  await artifact.stream.emit('close')
  t.comment(`timing: stream release took ${(now() - started).toFixed(1)}ms`)

  t.is(clears.length, 1, 'blocks cleared when the stream closes without ending')
  t.alike(clears[0], { start: 0, end: 10 }, 'cleared the model block range')
  const destroyedAt = client._events.indexOf('destroy')
  t.ok(
    destroyedAt !== -1 && destroyedAt < client._events.indexOf('clear'),
    'replication is stopped before clearing so blocks are not refetched'
  )
})

test('downloadModel releases the stream download exactly once', async (t) => {
  const client = makeClient(t)
  let clears = 0
  // lunte-disable-next-line require-await
  client._clearBlobBlocks = async () => {
    clears++
    t.comment(`step: _clearBlobBlocks call #${clears}`)
  }

  const { artifact } = await client.downloadModel('models/tiny.gguf', 's3')

  t.comment("step: emitting 'end' (normal completion)")
  await artifact.stream.emit('end')
  t.comment("step: emitting 'close' (follows end on an autodestroyed stream)")
  await artifact.stream.emit('close')

  t.is(clears, 1, 'the end-then-close sequence releases only once')
})

test('downloadBlob clears cached blocks when the returned stream is destroyed', async (t) => {
  const client = makeClient(t)
  // lunte-disable-next-line require-await
  client.ready = async () => {}
  const clears = []
  // lunte-disable-next-line require-await
  client._clearBlobBlocks = async (core, start, end) => {
    clears.push({ start, end })
    t.comment(`step: _clearBlobBlocks(${start}, ${end}) called`)
  }

  const { artifact } = await client.downloadBlob({
    coreKey: Buffer.alloc(32),
    blockOffset: 3,
    blockLength: 7,
    byteLength: 700
  })

  t.comment("step: emitting 'close' without 'end' on the direct blob stream")
  await artifact.stream.emit('close')

  t.is(clears.length, 1, 'blocks cleared when the stream closes without ending')
  t.alike(clears[0], { start: 3, end: 10 }, 'cleared the blob block range')
})

test('downloadBlob clears cached blocks when the download is cancelled', async (t) => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'blob.bin')

  const client = makeClient(t)
  // lunte-disable-next-line require-await
  client.ready = async () => {}
  const clears = []
  client._core.download = () => ({
    destroy() {
      client._events.push('destroy')
      t.comment('step: rangeDownload.destroy() called from the catch path')
    }
  })
  // lunte-disable-next-line require-await
  client._clearBlobBlocks = async (core, start, end) => {
    client._events.push('clear')
    clears.push({ start, end })
    t.comment(`step: _clearBlobBlocks(${start}, ${end}) called`)
  }
  // lunte-disable-next-line require-await
  client._streamBlobToFile = async () => {
    t.comment('step: _streamBlobToFile rejecting to force the catch path')
    throw new Error('Download cancelled')
  }

  const blobBinding = {
    coreKey: Buffer.alloc(32),
    blockOffset: 3,
    blockLength: 7,
    byteLength: 700
  }

  await t.exception(
    () => client.downloadBlob(blobBinding, { outputFile, signal: { aborted: true } }),
    /Download cancelled/,
    'the cancelled direct blob download rejects'
  )

  t.is(clears.length, 1, 'partial blocks cleared exactly once on the cancel path')
  t.alike(clears[0], { start: 3, end: 10 }, 'cleared the blob block range')
  const destroyedAt = client._events.indexOf('destroy')
  t.ok(
    destroyedAt !== -1 && destroyedAt < client._events.indexOf('clear'),
    'replication is stopped before clearing so blocks are not refetched'
  )
})

// Cancels from inside the stream attempt, the way an AbortSignal fires while
// blocks are still arriving.
function cancellingStream(client, signal) {
  // lunte-disable-next-line require-await
  return async () => {
    client._events.push('stream')
    signal.aborted = true
    throw new Error('Download cancelled')
  }
}

function recordReleases(client) {
  const released = { clears: [], destroyed: 0, closed: 0 }
  client._core.download = () => ({
    destroy() {
      released.destroyed++
    }
  })
  // lunte-disable-next-line require-await
  client._core.close = async () => {
    released.closed++
  }
  // lunte-disable-next-line require-await
  client._clearBlobBlocks = async (core, start, end) => {
    released.clears.push({ start, end })
  }
  return released
}

test('downloadModel keeps cached blocks on cancel when clearBlocksOnCancel is false', async (t) => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'model.gguf')

  const client = makeClient(t)
  const released = recordReleases(client)
  const signal = { aborted: false }
  client._streamBlobToFile = cancellingStream(client, signal)

  await t.exception(
    () =>
      client.downloadModel('models/tiny.gguf', 's3', {
        outputFile,
        signal,
        clearBlocksOnCancel: false
      }),
    /Download cancelled/
  )

  t.is(released.clears.length, 0, 'cached blocks kept so the next download resumes')
  t.ok(released.destroyed > 0, 'replication stopped')
  t.is(released.closed, 1, 'core closed')
})

test('downloadModel clears cached blocks on cancel by default', async (t) => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'model.gguf')

  const client = makeClient(t)
  const released = recordReleases(client)
  const signal = { aborted: false }
  client._streamBlobToFile = cancellingStream(client, signal)

  await t.exception(
    () =>
      client.downloadModel('models/tiny.gguf', 's3', {
        outputFile,
        signal
      }),
    /Download cancelled/
  )

  t.alike(released.clears, [{ start: 0, end: 10 }], 'model block range cleared once')
  t.is(released.closed, 1, 'core closed')
})

test('downloadModel reads a clearBlocksOnCancel callback at cancel time', async (t) => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'model.gguf')

  const client = makeClient(t)
  const released = recordReleases(client)
  const signal = { aborted: false }
  let clearRequested = true
  // lunte-disable-next-line require-await
  client._streamBlobToFile = async () => {
    // The caller decides to keep the blocks while the download is already running.
    clearRequested = false
    signal.aborted = true
    throw new Error('Download cancelled')
  }

  await t.exception(
    () =>
      client.downloadModel('models/tiny.gguf', 's3', {
        outputFile,
        signal,
        clearBlocksOnCancel: () => clearRequested
      }),
    /Download cancelled/
  )

  t.is(released.clears.length, 0, 'callback value at cancel time is honoured')
})

test('downloadBlob keeps cached blocks on cancel when clearBlocksOnCancel is false', async (t) => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'blob.bin')

  const client = makeClient(t)
  // lunte-disable-next-line require-await
  client.ready = async () => {}
  const released = recordReleases(client)
  const signal = { aborted: false }
  client._streamBlobToFile = cancellingStream(client, signal)

  const blobBinding = {
    coreKey: Buffer.alloc(32),
    blockOffset: 3,
    blockLength: 7,
    byteLength: 700
  }

  await t.exception(
    () => client.downloadBlob(blobBinding, { outputFile, signal, clearBlocksOnCancel: false }),
    /Download cancelled/
  )

  t.is(released.clears.length, 0, 'cached blocks kept so the next download resumes')
  t.is(released.closed, 1, 'core closed')
})

test('downloadBlob clears cached blocks on cancel by default', async (t) => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'blob.bin')

  const client = makeClient(t)
  // lunte-disable-next-line require-await
  client.ready = async () => {}
  const released = recordReleases(client)
  const signal = { aborted: false }
  client._streamBlobToFile = cancellingStream(client, signal)

  const blobBinding = {
    coreKey: Buffer.alloc(32),
    blockOffset: 3,
    blockLength: 7,
    byteLength: 700
  }

  await t.exception(
    () => client.downloadBlob(blobBinding, { outputFile, signal }),
    /Download cancelled/
  )

  t.alike(released.clears, [{ start: 3, end: 10 }], 'blob block range cleared once')
})

test('downloadModel keeps cached blocks when the download fails', async (t) => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'model.gguf')

  const client = makeClient(t)
  const released = recordReleases(client)
  // lunte-disable-next-line require-await
  client._streamBlobToFile = async () => {
    throw new Error('peer went away')
  }

  await t.exception(
    () => client.downloadModel('models/tiny.gguf', 's3', { outputFile, clearBlocksOnCancel: true }),
    /peer went away/
  )

  t.is(released.clears.length, 0, 'a failure keeps blocks so the next load resumes')
  t.is(released.closed, 1, 'core closed')
})

test('downloadBlob keeps cached blocks when the download fails', async (t) => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'blob.bin')

  const client = makeClient(t)
  // lunte-disable-next-line require-await
  client.ready = async () => {}
  const released = recordReleases(client)
  // lunte-disable-next-line require-await
  client._streamBlobToFile = async () => {
    throw new Error('peer went away')
  }

  await t.exception(
    () =>
      client.downloadBlob(
        { coreKey: Buffer.alloc(32), blockOffset: 3, blockLength: 7, byteLength: 700 },
        { outputFile }
      ),
    /peer went away/
  )

  t.is(released.clears.length, 0, 'a failure keeps blocks so the next load resumes')
})

test('downloadBlob waits for a clearing cancel of the same blob before counting blocks', async (t) => {
  const dir = await tmp(t)
  const outputFile = path.join(dir, 'blob.bin')

  const client = makeClient(t)
  // lunte-disable-next-line require-await
  client.ready = async () => {}
  client._core.key = Buffer.alloc(32)
  client._core.download = () => ({ destroy() {} })
  let finishClear
  client._clearBlobBlocks = () => {
    if (finishClear) return Promise.resolve()
    client._events.push('clear-start')
    return new Promise((resolve) => {
      finishClear = () => {
        client._events.push('clear-done')
        resolve()
      }
    })
  }
  const blobBinding = { coreKey: Buffer.alloc(32), blockOffset: 3, blockLength: 7, byteLength: 700 }

  // lunte-disable-next-line require-await
  client._streamBlobToFile = async () => {
    throw new Error('Download cancelled')
  }
  const first = client.downloadBlob(blobBinding, { outputFile, signal: { aborted: true } })
  first.catch(() => {})
  while (!finishClear) await new Promise((resolve) => setImmediate(resolve))

  // lunte-disable-next-line require-await
  client._streamBlobToFile = async () => {
    client._events.push('second-stream')
  }
  const second = client.downloadBlob(blobBinding, { outputFile })
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.absent(client._events.includes('second-stream'), 'second download waits for the clear')

  finishClear()
  await t.exception(first, /Download cancelled/)
  await second
  t.ok(
    client._events.indexOf('clear-done') < client._events.indexOf('second-stream'),
    'second download counts blocks only after the clear finished'
  )
})

test('clearBlob clears the blob block range and closes the core', async (t) => {
  const client = makeClient(t)
  // lunte-disable-next-line require-await
  client.ready = async () => {}
  const released = recordReleases(client)

  await client.clearBlob({ coreKey: Buffer.alloc(32), blockOffset: 3, blockLength: 7 })

  t.alike(released.clears, [{ start: 3, end: 10 }], 'blob block range cleared')
  t.is(released.closed, 1, 'core closed')
})

test('clearBlob reports a failed clear and still closes the core', async (t) => {
  const client = makeClient(t)
  // lunte-disable-next-line require-await
  client.ready = async () => {}
  let closed = 0
  // lunte-disable-next-line require-await
  client._core.close = async () => {
    closed++
  }
  // lunte-disable-next-line require-await
  client._core.clear = async () => {
    throw new Error('disk full')
  }
  delete client._clearBlobBlocks

  await t.exception(
    () => client.clearBlob({ coreKey: Buffer.alloc(32), blockOffset: 3, blockLength: 7 }),
    /disk full/
  )
  t.is(closed, 1, 'core closed')
})

test('downloadBlob waits for a clearBlob of the same blob that is still draining', async (t) => {
  const dir = await tmp(t)
  const client = makeClient(t)
  // lunte-disable-next-line require-await
  client.ready = async () => {}
  client._core.download = () => ({ destroy() {} })
  let finishDrain
  client._waitForInflightBlocks = () =>
    new Promise((resolve) => {
      finishDrain = () => {
        client._events.push('drain-done')
        resolve()
      }
    })
  // lunte-disable-next-line require-await
  client._clearBlobBlocks = async () => {
    client._events.push('clear')
  }
  // lunte-disable-next-line require-await
  client._streamBlobToFile = async () => {
    client._events.push('stream')
  }
  const blobBinding = { coreKey: Buffer.alloc(32), blockOffset: 3, blockLength: 7, byteLength: 700 }

  const clearing = client.clearBlob(blobBinding)
  while (!finishDrain) await new Promise((resolve) => setImmediate(resolve))
  // lunte-disable-next-line require-await
  client._waitForInflightBlocks = async () => {}

  const download = client.downloadBlob(blobBinding, { outputFile: path.join(dir, 'blob.bin') })
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.absent(client._events.includes('stream'), 'download waits while the clear drains')

  finishDrain()
  await clearing
  await download
  t.ok(
    client._events.indexOf('clear') < client._events.indexOf('stream'),
    'download streams only after the clear finished'
  )
})

test('downloadBlob called right after clearBlob waits for the clear', async (t) => {
  const dir = await tmp(t)
  const client = makeClient(t)
  const opened = new Promise((resolve) => setImmediate(resolve))
  client.ready = () => opened
  client._core.download = () => ({ destroy() {} })
  let finishDrain
  let drains = 0
  client._waitForInflightBlocks = () => {
    if (drains++ > 0) return Promise.resolve()
    return new Promise((resolve) => {
      finishDrain = resolve
    })
  }
  // lunte-disable-next-line require-await
  client._clearBlobBlocks = async () => {
    client._events.push('clear')
  }
  // lunte-disable-next-line require-await
  client._streamBlobToFile = async () => {
    client._events.push('stream')
  }
  const blobBinding = { coreKey: Buffer.alloc(32), blockOffset: 3, blockLength: 7, byteLength: 700 }

  const clearing = client.clearBlob(blobBinding)
  const download = client.downloadBlob(blobBinding, { outputFile: path.join(dir, 'blob.bin') })
  while (!finishDrain) await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.absent(client._events.includes('stream'), 'download waits while the clear drains')

  finishDrain()
  await clearing
  await download
  t.ok(
    client._events.indexOf('clear') < client._events.indexOf('stream'),
    'download streams only after the clear finished'
  )
})

test('clearBlob rejects a binding without a block range', async (t) => {
  const client = makeClient(t)
  await t.exception(() => client.clearBlob({ coreKey: Buffer.alloc(32) }), /blockOffset/)
})

test('downloadModel releases nothing when it fails before the core is opened', async (t) => {
  const client = makeClient(t)
  let clears = 0
  // lunte-disable-next-line require-await
  client._clearBlobBlocks = async () => {
    clears++
    t.comment('step: _clearBlobBlocks called')
  }
  // lunte-disable-next-line require-await
  client.getModel = async () => {
    t.comment('step: getModel returning null, failing before _getBlobsCore')
    return null
  }

  await t.exception(
    () => client.downloadModel('models/missing.gguf', 's3'),
    /Model not found/,
    'the missing model rejects'
  )

  t.is(clears, 0, 'nothing cleared when no core or block range exists yet')
})

test('downloadModel closes the core without clearing when the range is unknown', async (t) => {
  const client = makeClient(t)
  let clears = 0
  let closed = 0
  // lunte-disable-next-line require-await
  client._clearBlobBlocks = async () => {
    clears++
    t.comment('step: _clearBlobBlocks called')
  }
  // lunte-disable-next-line require-await
  client._core.close = async () => {
    closed++
    t.comment('step: core.close() called')
  }
  // lunte-disable-next-line require-await
  client._core.update = async () => {
    t.comment('step: core.update() rejecting before the block range is computed')
    throw new Error('core update failed')
  }

  await t.exception(
    () => client.downloadModel('models/tiny.gguf', 's3'),
    /core update failed/,
    'the failed core update rejects'
  )

  t.is(clears, 0, 'no clear attempted while blockStart is still unassigned')
  t.is(closed, 1, 'the opened core is still closed on the way out')
})

// Locks the generic retry contract the download path relies on.
test('withRetry retries only listed codes and stays bounded', async (t) => {
  let calls = 0
  await t.exception(
    () =>
      withRetry(
        // lunte-disable-next-line require-await
        async () => {
          calls++
          throw requestTimeout()
        },
        { maxRetries: 3, retryCodes: ['REQUEST_TIMEOUT'] }
      ),
    /request timed out/
  )
  t.is(calls, 3, 'retried up to maxRetries')

  let nonRetriable = 0
  await t.exception(
    () =>
      withRetry(
        // lunte-disable-next-line require-await
        async () => {
          nonRetriable++
          const e = new Error('nope')
          e.code = 'OTHER'
          throw e
        },
        { maxRetries: 3, retryCodes: ['REQUEST_TIMEOUT'] }
      ),
    /nope/
  )
  t.is(nonRetriable, 1, 'non-retriable error propagates immediately')
})
