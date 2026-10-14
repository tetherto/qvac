'use strict'

const fs = require('bare-fs')
const path = require('bare-path')

const ENCODER_RE = /^moss-codec-encoder(-[a-z0-9_]+)?\.gguf$/i
const DIALOGUE_BACKBONE_RE = /^moss-ttsd(-[a-z0-9_]+)?\.gguf$/i
const REQUIRED_MODELS = {
  QVAC_TEST_MOSS_MODEL_DIR: [
    ['TTS backbone', /^moss-tts-delay(-[a-z0-9_]+)?\.gguf$/i],
    ['TTSD backbone', DIALOGUE_BACKBONE_RE],
    ['codec decoder', /^moss-codec-decoder(-[a-z0-9_]+)?\.gguf$/i],
    ['codec encoder', ENCODER_RE]
  ],
  QVAC_TEST_MOSS_SPEECH_MODEL_DIR: [
    ['Speech backbone', /^moss-speech(-(?!codec)[a-z0-9_]+)?\.gguf$/i],
    ['Speech codec', /^moss-speech-codec(-[a-z0-9_]+)?\.gguf$/i]
  ]
}

function requireValidation(condition, message) {
  if (!condition) throw new Error(`MOSS full GPU validation: ${message}`)
}

function isFile(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile()
}

// Called before either suite registers tests. Reuse each suite's reference WAV
// resolver so preflight and inference cannot silently select different audio.
function createMossGpuValidation(env, referenceAudio, gpuOnlyUseGPU = true) {
  const enabled = env.QVAC_TEST_MOSS_FULL_GPU === 'true'
  const completed = new Set()
  if (enabled) {
    requireValidation(env.NO_GPU !== 'true', 'NO_GPU=true conflicts with full GPU validation')
    requireValidation(gpuOnlyUseGPU, 'full GPU validation requires the desktop GPU cases')
    requireValidation(
      ['cuda', 'vulkan', 'metal', 'opencl'].includes((env.TTS_CPP_GPU_BACKEND || '').toLowerCase()),
      'set TTS_CPP_GPU_BACKEND to cuda, vulkan, metal or opencl'
    )
    for (const [variable, requirements] of Object.entries(REQUIRED_MODELS)) {
      const directory = env[variable]
      requireValidation(
        directory && fs.existsSync(directory) && fs.statSync(directory).isDirectory(),
        `${variable} must name an existing model directory`
      )
      const files = fs.readdirSync(directory).filter((entry) => isFile(path.join(directory, entry)))
      for (const [label, pattern] of requirements) {
        requireValidation(
          files.some((file) => pattern.test(file)),
          `${variable}: missing ${label}`
        )
      }
    }
    requireValidation(isFile(referenceAudio), `reference WAV is missing: ${referenceAudio}`)
  }
  return {
    enabled,
    completed(caseName) {
      completed.add(caseName)
    },
    assertComplete(t, expected) {
      for (const caseName of expected) {
        t.ok(completed.has(caseName), `full GPU validation executed ${caseName}`)
      }
    }
  }
}

module.exports = { createMossGpuValidation, ENCODER_RE, DIALOGUE_BACKBONE_RE }
