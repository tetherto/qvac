'use strict'

const fs = require('bare-fs')
const path = require('bare-path')

const origLog = console.log

console.log = function () {
  origLog.apply(console, arguments)
  if (arguments.length === 1) {
    const arg = arguments[0]
    if (arg === '# ok' || arg === '# not ok') {
      writeExitCode()
    }
  }
}

require('./all.js')

const RUNNER = Symbol.for('brittle-runner')

function writeExitCode () {
  let code = 0
  if (global.Bare && global.Bare.exitCode !== undefined) code = global.Bare.exitCode
  try {
    fs.writeFileSync(path.join(__dirname, '.exit-code'), String(code))
  } catch (e) {}
}

let lastCount = 0
let stableTicks = 0
let done = false
const stabilityPoll = setInterval(function () {
  if (done) { clearInterval(stabilityPoll); return }
  const runner = global[RUNNER]
  if (!runner || !runner.started) return

  const count = runner.tests.count
  if (count > 0 && count === lastCount && runner.next === null) {
    stableTicks++
  } else {
    stableTicks = 0
  }
  lastCount = count

  if (stableTicks >= 3) {
    done = true
    clearInterval(stabilityPoll)
    try { runner.end() } catch (e) {}
  }
}, 5000)
