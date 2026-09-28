'use strict'

// Bundle with bare-pack --linked for the mobile target. The host provides
// QVAC_POCKET_MODEL_DIR and reads one JSON result from BareKit.IPC. Exporting
// the integration-test promise lets this worklet report completion without
// relying on beforeExit, since the host's IPC connection keeps it alive.
/* global BareKit, Bare */
let sent = false
let assertions = 0
let failed = false
const tap = []
const send = (result) => {
  if (sent) return
  sent = true
  BareKit.IPC.write(
    Buffer.from(JSON.stringify({ ...result, assertions, tap, versions: Bare.versions }) + '\n')
  )
}
Bare.on('uncaughtException', (error) =>
  send({ passed: false, error: String(error.stack || error) })
)
Bare.on('unhandledRejection', (error) =>
  send({ passed: false, error: String(error.stack || error) })
)

const originalLog = console.log.bind(console)
console.log = (...args) => {
  originalLog(...args)
  tap.push(args.map(String).join(' '))
  const line = String(args[0] || '')
  if (/^\s+(?:not )?ok \d/.test(line)) assertions++
  if (/^\s*not ok \d/.test(line)) failed = true
}

const process = require('bare-process')
global.process = process
if (!process.env.QVAC_POCKET_MODEL_DIR) {
  send({
    passed: false,
    error: 'QVAC_POCKET_MODEL_DIR is required; mobile validation must not skip inference'
  })
} else {
  Promise.resolve(require('../integration/pocket.integration.test.js')).then(
    () => send({ passed: !failed && assertions > 0 && !Bare.exitCode }),
    (error) => send({ passed: false, error: String(error.stack || error) })
  )
}
