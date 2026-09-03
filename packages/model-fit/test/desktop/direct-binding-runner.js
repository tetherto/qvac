'use strict'

const process = require('bare-process')
const binding = require('../../binding-internal.js')

try {
  const result = binding.llamaConfigFit(JSON.parse(process.argv[2]))
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`)
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error)
    })}\n`
  )
}
