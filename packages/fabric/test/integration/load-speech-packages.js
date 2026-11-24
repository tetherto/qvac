'use strict'

function loadSpeechPackages() {
  require('@qvac/tts-ggml/binding.js')
  require('@qvac/audiogen-ggml/binding.js')
  require('@qvac/bci-whispercpp/binding.js')
  require('@qvac/asr-ggml/binding.js')
  return require('@qvac/asr-ggml')
}

function loadLlmPackage() {
  require('@qvac/llm-llamacpp/binding.js')
  return require('@qvac/llm-llamacpp')
}

function loadPackages(speechFirst) {
  if (speechFirst) {
    const ASR = loadSpeechPackages()
    return { ASR, LLM: loadLlmPackage() }
  }
  const LLM = loadLlmPackage()
  return { LLM, ASR: loadSpeechPackages() }
}

module.exports = { loadPackages }
