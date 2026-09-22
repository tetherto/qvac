'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')

const { assessFit } = require('../../index.js')

function tempFile(t, name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-fit-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, contents)
  return filePath
}

test('a model that cannot be read is an outcome, not a throw', (t) => {
  const fit = assessFit({ modelPath: '/nonexistent/model.gguf' })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
  t.alike(fit.devices, [])
  t.is(fit.deviceBytes, 0)
  t.is(fit.hostBytes, 0)
})

test('a file that is not a GGUF is unreadable too', (t) => {
  const filePath = tempFile(t, 'model.gguf', Buffer.alloc(512, 7))

  const fit = assessFit({ modelPath: filePath })

  t.is(fit.status, 'error')
})

test('an outcome with no projection reports no fitted values', (t) => {
  const fit = assessFit({
    modelPath: '/nonexistent/model.gguf',
    params: { 'ctx-size': '8192' }
  })

  t.is(fit.gpuLayers, 0)
  t.is(fit.ctxSize, 0)
})

// The load is dispatched through llama's argument table before the model is
// opened, so a setting llama does not recognise is refused ahead of the read
// that would otherwise report the file as unreadable.
test('a setting llama does not recognise is refused before the model is read', (t) => {
  const filePath = tempFile(t, 'model.gguf', Buffer.alloc(512, 7))

  const fit = assessFit({ modelPath: filePath, params: { 'not-a-flag': '1' } })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-config')
})

test('a recognised setting reaches the model read', (t) => {
  const filePath = tempFile(t, 'model.gguf', Buffer.alloc(512, 7))

  const fit = assessFit({ modelPath: filePath, params: { 'ctx-size': '4096' } })

  t.is(fit.status, 'error')
  t.not(fit.reason, 'unsupported-config')
})
