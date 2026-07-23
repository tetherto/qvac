'use strict'

// Single source of truth for CLI source definitions used by both
// build-cli-sources.js (clone + build) and the orchestrator (dispatch).
// The fabric ref should stay in lockstep with the qvac-fabric version
// in packages/llm-llamacpp/vcpkg.json.

module.exports = {
  fabric: {
    repo: 'https://github.com/tetherto/qvac-fabric-llm.cpp',
    ref: 'v8189.0.2',
    label: 'fabric-cli',
    cmakeFlags: {
      CMAKE_BUILD_TYPE: 'Release',
      LLAMA_BUILD_TOOLS: 'ON',
      LLAMA_MTMD: 'ON',
      LLAMA_BUILD_COMMON: 'ON',
      BUILD_SHARED_LIBS: 'OFF',
      LLAMA_BUILD_TESTS: 'OFF',
      LLAMA_BUILD_EXAMPLES: 'OFF',
      LLAMA_BUILD_SERVER: 'OFF',
      GGML_NATIVE: 'OFF',
      GGML_OPENMP: 'OFF'
    }
  },
  upstream: {
    repo: 'https://github.com/ggml-org/llama.cpp',
    ref: 'b8189',
    label: 'upstream-cli',
    cmakeFlags: {
      CMAKE_BUILD_TYPE: 'Release',
      LLAMA_BUILD_TOOLS: 'ON',
      LLAMA_MTMD: 'ON',
      LLAMA_BUILD_COMMON: 'ON',
      BUILD_SHARED_LIBS: 'OFF',
      LLAMA_BUILD_TESTS: 'OFF',
      LLAMA_BUILD_EXAMPLES: 'OFF',
      LLAMA_BUILD_SERVER: 'OFF',
      GGML_NATIVE: 'OFF',
      GGML_OPENMP: 'OFF'
    }
  }
}
