'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')

const ASRGgml = require('../../index.js')

function tempFile(t, name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-fit-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, contents)
  return filePath
}

test('an unreadable model returns an error outcome', (t) => {
  const fit = ASRGgml.assessFit({ modelPath: '/nonexistent/model.gguf' })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
})

test('a file that is not a GGUF is unreadable too', (t) => {
  const filePath = tempFile(t, 'model.gguf', Buffer.alloc(512, 7))

  const fit = ASRGgml.assessFit({ modelPath: filePath })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
})

test('a whisper model that cannot be read is an outcome too', (t) => {
  const fit = ASRGgml.assessFit({
    engine: 'whisper',
    modelPath: '/nonexistent/model.bin'
  })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
})

test('each engine reports its own breakdown', (t) => {
  const parakeet = ASRGgml.assessFit({ modelPath: '/nonexistent/model.gguf' })
  const whisper = ASRGgml.assessFit({
    engine: 'whisper',
    modelPath: '/nonexistent/model.bin'
  })

  t.is(typeof parakeet.encoderComputeBytes, 'number', 'parakeet encoder compute')
  t.is(typeof whisper.kvBytes, 'number', 'whisper kv')
  t.is(typeof whisper.vadBytes, 'number', 'whisper vad')
  t.is(typeof whisper.hostOverflowBytes, 'number', 'whisper host overflow')
})

// Dispatch is by name, so an unrecognised one is a broken request rather than
// a model the parakeet fitter happens not to be able to read.
test('an unrecognised engine is refused', (t) => {
  t.exception(
    () => ASRGgml.assessFit({ engine: 'Whisper', modelPath: '/nonexistent/model.bin' }),
    /Unknown fit engine/
  )
})

test('a missing model path is rejected', (t) => {
  t.exception(() => ASRGgml.assessFit({}))
})
