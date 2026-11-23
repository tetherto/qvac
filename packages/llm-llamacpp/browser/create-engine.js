'use strict'

const MEMORY64_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1])

async function defaultFactory(options) {
  const engine = WebAssembly.validate(MEMORY64_PROBE)
    ? await import('../prebuilds/web/llm-llamacpp-64.mjs')
    : await import('../prebuilds/web/llm-llamacpp.mjs')
  return engine.default(options)
}

let factory = defaultFactory

function createEngine(options) {
  return factory(options)
}

createEngine.setFactory = (next) => {
  factory = next ?? defaultFactory
}

module.exports = createEngine
