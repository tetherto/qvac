'use strict'

// IdMapIndex cases that need bare-thread or bare-abort-controller. The mobile
// test app does not install either, and its bundler resolves every require in
// a test file, skipped tests included, so these cases cannot share a file
// with the mobile suite. scripts/mobile-integration-exclusions.js keeps this
// file out of the mobile app; `npm run test:integration` still runs it.

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')

const IdMapIndex = require('@qvac/turbovec-ggml/idMapIndex')

// Large enough that an IVF build runs for a while on any test host.
const BUSY_ROWS = 20_000
const BUSY_DIM = 64
const BUSY_LISTS = 128
const BUSY_ITERS = 5

function removeFile(file) {
  for (const artifact of [file, `${file}.lock`]) {
    if (fs.existsSync(artifact)) fs.unlinkSync(artifact)
  }
}

function unitVec(i, dim) {
  const vector = new Float32Array(dim)
  vector[i % dim] = 1
  return vector
}

// Deterministic pseudo-random rows, so every run builds the same index.
function randomBatch(n, dim, seed = 0x5eed) {
  let state = seed >>> 0
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000 - 0.5
  }
  const vectors = new Float32Array(n * dim)
  for (let i = 0; i < vectors.length; i++) vectors[i] = next()
  const ids = new BigUint64Array(n)
  for (let i = 0; i < n; i++) ids[i] = BigInt(i + 1)
  return { vectors, ids }
}

async function busyIndex() {
  const idx = new IdMapIndex({ dim: BUSY_DIM, bitWidth: 32 })
  const { vectors, ids } = randomBatch(BUSY_ROWS, BUSY_DIM)
  await idx.addWithIds(vectors, ids)
  return idx
}

async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  return null
}

// A job still waiting for a worker thread when its Bare environment shuts down
// is dropped, so the shutdown waits only for the job that is running.
test('IdMapIndex async: a job still waiting at env shutdown never runs', async (t) => {
  t.timeout(120_000)
  const Thread = require('bare-thread')
  const base = path.join(os.tmpdir(), `turbovec-ggml-teardown-${os.pid()}`)
  const ready = `${base}.ready`
  const written = `${base}.tvim`
  removeFile(ready)
  removeFile(written)

  const thread = new Thread(require.resolve('./teardown-worker.js'))
  let terminated = false
  try {
    for (let i = 0; i < 6000 && !fs.existsSync(ready); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    t.ok(fs.existsSync(ready), 'the worker started a build and queued a write behind it')
    thread.terminate()
    terminated = true
  } finally {
    if (!terminated) thread.terminate()
    // Waits for the running build, which the shutdown lets finish.
    thread.join()
  }
  t.absent(fs.existsSync(written), 'the queued write never ran')
  removeFile(ready)
  removeFile(written)
})

test('IdMapIndex abort: works with a bare-abort-controller signal', async (t) => {
  const { AbortController } = require('bare-abort-controller')
  const idx = await busyIndex()
  try {
    const build = idx.buildIvf(BUSY_LISTS, BUSY_ITERS)
    const controller = new AbortController()
    const search = rejection(idx.search(unitVec(0, BUSY_DIM), 1, { signal: controller.signal }))
    controller.abort()
    t.is((await search)?.name, 'AbortError', 'the queued search rejects with an AbortError')
    await build
    const again = await rejection(
      idx.search(unitVec(0, BUSY_DIM), 1, { signal: controller.signal })
    )
    t.is(again?.name, 'AbortError', 'an already aborted signal rejects a new call')
  } finally {
    await idx.dispose()
  }
})
