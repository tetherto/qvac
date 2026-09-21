'use strict'

const test = require('brittle')

const { parseCloneArgs } = require('../../examples/parse-clone-args')

test('parseCloneArgs: full cloning invocation maps every field', (t) => {
  const parsed = parseCloneArgs([
    '--gpu',
    '--reference-audio',
    'me.wav',
    '--prompt-text',
    'what it says',
    'synthesize this',
    'happy',
    '/models/cosyvoice3'
  ])
  t.is(parsed.useGPU, true)
  t.is(parsed.refAudio, 'me.wav')
  t.is(parsed.promptText, 'what it says')
  t.alike(parsed.positional, ['synthesize this', 'happy', '/models/cosyvoice3'])
})

test('parseCloneArgs: cross-lingual (no prompt text) and plain baked runs', (t) => {
  const xl = parseCloneArgs(['--reference-audio', 'me.wav', 'text'])
  t.is(xl.refAudio, 'me.wav')
  t.is(xl.promptText, undefined)
  t.alike(xl.positional, ['text'])

  const baked = parseCloneArgs(['text only'])
  t.is(baked.useGPU, false)
  t.is(baked.refAudio, undefined)
  t.alike(baked.positional, ['text only'])
})

test('parseCloneArgs: missing or option-shaped flag values fail loud', (t) => {
  t.exception(
    () => parseCloneArgs(['text', '--reference-audio']),
    /--reference-audio needs a value/,
    'trailing flag without a value throws'
  )
  t.exception(
    () => parseCloneArgs(['--reference-audio', '--prompt-text', 'x', 'text']),
    /--reference-audio needs a value/,
    'a flag consuming another option throws instead of mis-parsing'
  )
  t.exception(
    () => parseCloneArgs(['--prompt-text']),
    /--prompt-text needs a value/,
    'trailing prompt-text without a value throws'
  )
})
