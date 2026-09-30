'use strict'

const process = require('bare-process')
const binding = require('../../binding-internal.js')

// argv[3] === 'async' routes the request through the promise-returning entry.
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
