'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')

const { assessFit } = require('../../index.js')

function tempFile(t, name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-fit-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, contents)
  return filePath
}

test('a request naming no model is an outcome, not a throw', (t) => {
  const fit = assessFit({})

  t.is(fit.status, 'error')
  t.is(fit.reason, 'invalid-arguments')
})

test('a model that cannot be read is an outcome, not a throw', (t) => {
  const fit = assessFit({
    textEncoderPath: '/nonexistent/text.gguf',
    lmPath: '/nonexistent/lm.gguf',
    ditPath: '/nonexistent/dit.gguf',
    vaePath: '/nonexistent/vae.gguf'
  })

  t.is(fit.status, 'error')
  t.ok(fit.reason.length > 0)
})

test('a file that is not a GGUF is unreadable too', (t) => {
  const filePath = tempFile(t, 'dit.gguf', Buffer.alloc(512, 7))

  const fit = assessFit({
    textEncoderPath: filePath,
    lmPath: filePath,
    ditPath: filePath,
    vaePath: filePath
  })

  t.is(fit.status, 'error')
})

// Where the device has memory of its own, host bytes are weighed against a
// separate budget, so the projection carries both capacities.
test('the projection carries host capacity alongside host demand', (t) => {
  const fit = assessFit({ ditPath: '/nonexistent/dit.gguf' })

  t.is(typeof fit.hostFreeBytes, 'number')
  t.is(typeof fit.hostTotalBytes, 'number')
  t.ok(fit.hostFreeBytes <= fit.hostTotalBytes, 'free never exceeds installed')
})
