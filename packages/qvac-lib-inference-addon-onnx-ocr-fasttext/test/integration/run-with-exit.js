'use strict'

// Load the generated test runner (registers and starts tests).
// Native addon keeps the event loop alive, so brittle's beforeExit never fires.
// This wrapper polls the brittle runner and calls end() + exit when all tests are done.
require('./all.js')

const RUNNER = Symbol.for('brittle-runner')
const program = typeof process !== 'undefined' && process.exit ? process : global.Bare
const MAX_WAIT_MS = 10 * 60 * 1000 // 10 min - pipeline must not hang indefinitely
const startTime = Date.now()

function doExit (code) {
  if (typeof program.exit === 'function') {
    program.exit(code)
  } else if (typeof process !== 'undefined' && process.exit) {
    process.exit(code)
  }
}

function poll () {
  if (Date.now() - startTime > MAX_WAIT_MS) {
    console.error('# integration test run timed out after 10 minutes')
    doExit(1)
    return
  }
  const runner = global[RUNNER]
  if (!runner || !runner.started) {
    return setImmediate(poll)
  }
  if (runner.next !== null) {
    return setImmediate(poll)
  }
  const count = runner.tests.count
  if (count === 0) {
    return setImmediate(poll)
  }
  // runner.next is null - wait 1.5s to confirm no test is about to start (avoid race)
  setTimeout(function () {
    const r = global[RUNNER]
    if (!r || r.next !== null || r.tests.count !== count) {
      return setImmediate(poll)
    }
    r.end()
    setImmediate(function () {
      const code = (typeof process !== 'undefined' && process.exitCode !== undefined)
        ? process.exitCode
        : (global.Bare && global.Bare.exitCode !== undefined ? global.Bare.exitCode : 0)
      doExit(code || 0)
    })
  }, 1500)
}

setImmediate(poll)
