'use strict'

// Verifies that a per-call AbortSignal passed to run() is forwarded into the
// returned QvacResponse, so aborting mid-decode (or passing an already-aborted
// signal) settles the in-flight response with the abort reason.

const test = require('brittle')
const { FFmpegDecoder } = require('../../index.js')

function makeAbortable () {
  const listeners = new Set()
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener (event, cb, opts) {
      if (event !== 'abort') return
      const wrapped = opts && opts.once ? () => { listeners.delete(wrapped); cb() } : cb
      wrapped._original = cb
      listeners.add(wrapped)
    },
    removeEventListener (event, cb) {
      if (event !== 'abort') return
      for (const l of listeners) if (l === cb || l._original === cb) { listeners.delete(l); return }
    }
  }
  return {
    signal,
    abort (reason) {
      if (signal.aborted) return
      signal.aborted = true
      signal.reason = reason
      for (const l of Array.from(listeners)) l()
    }
  }
}

// Never-ending stream so the decode response stays in-flight until aborted.
function pendingStream () {
  return (async function * () {
    await new Promise(() => {})
  })()
}

async function expectRejection (t, promise, re, message) {
  let err
  try { await promise } catch (e) { err = e }
  t.ok(err, `${message}: rejected`)
  t.ok(err && re.test(err.message), `${message}: reason "${err && err.message}" matches ${re}`)
}

test('run(): aborting mid-decode rejects with the abort reason', async (t) => {
  const decoder = new FFmpegDecoder()
  await decoder.load()

  const { signal, abort } = makeAbortable()
  const response = decoder.run(pendingStream(), { signal })
  const settled = response.await()

  abort(new Error('aborted by caller'))
  await expectRejection(t, settled, /aborted by caller/, 'await()')
})

test('run(): an already-aborted signal rejects immediately', async (t) => {
  const decoder = new FFmpegDecoder()
  await decoder.load()

  const { signal, abort } = makeAbortable()
  abort(new Error('pre-aborted'))

  const response = decoder.run(pendingStream(), { signal })
  await expectRejection(t, response.await(), /pre-aborted/, 'await()')
})
