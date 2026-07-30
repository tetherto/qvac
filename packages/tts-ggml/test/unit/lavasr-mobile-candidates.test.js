'use strict'

// Unit tests for the mobile LavaSR candidate-path helpers in downloadModel.
// On Android the enhancer/denoiser GGUFs are adb-pushed into a `lavasr/` subdir
// of the prestage models dir (Android has no on-device registry), so the
// resolver must scan `<modelsDir>/lavasr/<file>`. These pin the path
// construction and the prestage dir that must stay in lockstep with
// scripts/generate-prestage-block.js.

const test = require('brittle')
const {
  lavasrCandidatePaths,
  androidLavasrCandidates,
  ANDROID_CANDIDATE_DIRS
} = require('../utils/downloadModel')

test('lavasrCandidatePaths joins each models dir with the lavasr/ subdir', (t) => {
  t.alike(lavasrCandidatePaths(['/data/local/tmp/qvac-tts-ggml/models'], 'lavasr-enhancer.gguf'), [
    '/data/local/tmp/qvac-tts-ggml/models/lavasr/lavasr-enhancer.gguf'
  ])
})

test('lavasrCandidatePaths preserves dir order for every candidate dir', (t) => {
  t.alike(lavasrCandidatePaths(['/a/models', '/b/models'], 'lavasr-denoiser.gguf'), [
    '/a/models/lavasr/lavasr-denoiser.gguf',
    '/b/models/lavasr/lavasr-denoiser.gguf'
  ])
})

test('the prestage device dir is among the Android candidate dirs', (t) => {
  // scripts/generate-prestage-block.js pushes to
  // /data/local/tmp/qvac-tts-ggml/models, so the resolver must scan it or the
  // pushed GGUF is invisible on device.
  t.ok(
    ANDROID_CANDIDATE_DIRS.includes('/data/local/tmp/qvac-tts-ggml/models'),
    'resolver scans the adb-push target dir'
  )
})

test('androidLavasrCandidates is empty off Android (falls through to registry)', (t) => {
  // These unit tests run on a desktop host, where mobile prestage does not
  // apply and resolution falls through to the on-device registry fetch.
  t.alike(androidLavasrCandidates('lavasr-enhancer.gguf'), [])
})
