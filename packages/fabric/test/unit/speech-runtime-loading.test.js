'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { evaluate } = require('./helpers')

const BINDINGS = [
  '@qvac/tts-ggml/binding.js',
  '@qvac/audiogen-ggml/binding.js',
  '@qvac/bci-whispercpp/binding.js',
  '@qvac/asr-ggml/binding.js',
  '@qvac/llm-llamacpp/binding.js'
]
const LLM_BINDING = '@qvac/llm-llamacpp/binding.js'

function loader(require) {
  return evaluate('test/integration/load-speech-packages.js', () => require).exports.loadPackages
}

function assertLoadOrder(speechFirst) {
  const loaded = []
  const load = loader((specifier) => {
    loaded.push(specifier)
    return {}
  })
  load(speechFirst)
  const bindings = loaded.filter((specifier) => specifier.endsWith('/binding.js'))
  assert.deepEqual(new Set(bindings), new Set(BINDINGS))
  assert.equal(bindings[speechFirst ? bindings.length - 1 : 0], LLM_BINDING)
}

test('LLM-first opens native bindings before returning lazy model wrappers', () =>
  assertLoadOrder(false))
test('speech-first opens all four speech bindings before the LLM binding', () =>
  assertLoadOrder(true))

function checkMissingBindings() {
  for (const missing of BINDINGS) {
    const load = loader((specifier) => {
      if (specifier === missing) throw new Error(`Missing native binding: ${missing}`)
      return {}
    })
    assert.throws(() => load(false), { message: `Missing native binding: ${missing}` })
    assert.throws(() => load(true), { message: `Missing native binding: ${missing}` })
  }
}

test(
  'missing native bindings fail the harness even when JS wrappers are available',
  checkMissingBindings
)
