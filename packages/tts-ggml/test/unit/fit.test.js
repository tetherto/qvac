'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')

const TTSGgml = require('../../index.js')

function tempFile(t, name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-fit-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, contents)
  return filePath
}

test('a model that cannot be read is an outcome, not a throw', (t) => {
  const fit = TTSGgml.assessFit({
    engineType: 'supertonic',
    modelPath: '/nonexistent/model.gguf'
  })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
})

test('a file that is not a GGUF is unreadable too', (t) => {
  const filePath = tempFile(t, 'model.gguf', Buffer.alloc(512, 7))

  const fit = TTSGgml.assessFit({ engineType: 'parler', modelPath: filePath })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
})

test('every engine routes to a fitter', (t) => {
  const requests = [
    { engineType: 'supertonic', modelPath: '/nonexistent/model.gguf' },
    { engineType: 'parler', modelPath: '/nonexistent/model.gguf' },
    { engineType: 'chatterbox', t3Path: '/nonexistent/t3.gguf', s3genPath: '/nonexistent/s3.gguf' },
    {
      engineType: 'audio8',
      lmPath: '/nonexistent/lm.gguf',
      codecDecoderPath: '/nonexistent/d.gguf'
    },
    {
      engineType: 'cosyvoice3',
      llmPath: '/nonexistent/llm.gguf',
      flowPath: '/nonexistent/flow.gguf',
      hiftPath: '/nonexistent/hift.gguf',
      voicePath: '/nonexistent/voice.gguf'
    }
  ]

  for (const request of requests) {
    const fit = TTSGgml.assessFit(request)
    t.is(fit.status, 'error', request.engineType)
    t.is(fit.reason, 'model-unreadable', request.engineType)
  }
})

test('an unknown engine is rejected', (t) => {
  t.exception(() => TTSGgml.assessFit({ engineType: 'nope', modelPath: '/x.gguf' }))
})

// A load names the engine from the file keys it carries; a fit request has
// none of them, so leaving it out would silently pick one.
test('an absent engine is rejected rather than inferred', (t) => {
  t.exception(
    () => TTSGgml.assessFit({ modelPath: '/nonexistent/model.gguf' }),
    /engineType is required/
  )
})
