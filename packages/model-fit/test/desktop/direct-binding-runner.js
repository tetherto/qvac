'use strict'

const process = require('bare-process')
const binding = require('../../binding-internal.js')

// argv[2] is the request; an optional argv[3] of 'async' routes it through the
// promise-returning entry point instead of the synchronous one.
const request = JSON.parse(process.argv[2])
const viaAsync = process.argv[3] === 'async'

function report(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

async function main() {
  const result = viaAsync
    ? await binding.llamaConfigFitAsync(request)
    : binding.llamaConfigFit(request)
  report({ ok: true, result })
}

main().catch((error) => {
  report({
    ok: false,
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error)
  })
})
