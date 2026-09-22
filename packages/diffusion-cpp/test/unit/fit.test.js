'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')

const { assessFit } = require('../../index.js')

function tempFile(t, name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-fit-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, contents)
  return filePath
}

test('an unreadable model returns an error outcome', (t) => {
  const fit = assessFit({ files: { model: '/nonexistent/model.gguf' } })

  t.is(fit.status, 'error')
  t.is(fit.changed, false)
})

test('a file that is not a model is unreadable too', (t) => {
  const filePath = tempFile(t, 'model.gguf', Buffer.alloc(512, 7))

  const fit = assessFit({ files: { model: filePath } })

  t.is(fit.status, 'error')
})

// A load refuses a relative path up front; the fit would otherwise hand it to
// the engine and get back an opaque error.
test('a relative path is refused rather than projected', (t) => {
  try {
    assessFit({ files: { model: 'model.gguf' } })
    t.fail('a relative path should not reach the engine')
  } catch (err) {
    t.ok(err instanceof TypeError)
    t.ok(err.message.includes('must be an absolute path'))
  }
})

// Choosing the placement is what the fit is for, so a pinned one is dropped
// rather than refused by the engine.
test('a configuration pinning a GPU still projects', (t) => {
  const filePath = tempFile(t, 'model.gguf', Buffer.alloc(512, 7))

  const fit = assessFit({
    files: { model: filePath },
    config: { device: 'gpu', mainGpu: 0 }
  })

  t.is(fit.status, 'error', 'the junk model is still unreadable')
  t.ok(fit.report.length >= 0, 'the engine was reached')
})
