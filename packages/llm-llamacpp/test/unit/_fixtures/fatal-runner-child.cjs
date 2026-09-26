'use strict'

// Runs in a child process: loading the runtime installs a beforeExit hook that
// exits non-zero once a fatal error is recorded, which would take the whole
// unit suite down if this ran in-process.
require('../../mobile/integration-runtime.cjs')

async function main() {
  const res = await global.runIntegrationModule('../unit/_fixtures/reject-module.mjs')
  console.log('RESULT ' + JSON.stringify(res.summary))
}

main()
