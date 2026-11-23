'use strict'

// A module that declares one page of 64-bit memory: it validates only where
// WebAssembly Memory64 is supported.
const MEMORY64_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1])

// Both imports stay literal so bundlers emit both engine variants.
async function createEngine(options) {
  const engine = WebAssembly.validate(MEMORY64_PROBE)
    ? await import('../prebuilds/web/llm-llamacpp-64.mjs')
    : await import('../prebuilds/web/llm-llamacpp.mjs')
  return engine.default(options)
}

module.exports = createEngine
