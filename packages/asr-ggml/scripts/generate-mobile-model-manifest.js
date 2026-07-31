'use strict'

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const REGISTRY_PREFIX_Q8_0 = 'qvac_models_compiled/ggml/parakeet/2026-05-11'
const REGISTRY_PREFIX_Q4_0 = 'qvac_models_compiled/ggml/parakeet/2026-05-27'
const REGISTRY_PREFIX_2026_07_01 = 'qvac_models_compiled/ggml/parakeet/2026-07-01'
const REGISTRY_PREFIX_STREAMING = 'qvac_models_compiled/ggml/parakeet/2026-05-20'
const DEFAULT_EXPIRES_IN = '604800'

const outputPath = path.resolve(__dirname, '../test/mobile/testAssets/model-manifest.json')

const MODELS = {
  ctcQ4: model('parakeet-ctc-0.6b.q4_0.gguf', REGISTRY_PREFIX_2026_07_01),
  ctcQ8: model('parakeet-ctc-0.6b.q8_0.gguf', REGISTRY_PREFIX_Q8_0),
  ctcF16: model('parakeet-ctc-0.6b.f16.gguf', REGISTRY_PREFIX_2026_07_01),
  tdtQ4: model('parakeet-tdt-0.6b-v3.q4_0.gguf', REGISTRY_PREFIX_Q4_0),
  tdtQ8: model('parakeet-tdt-0.6b-v3.q8_0.gguf', REGISTRY_PREFIX_Q8_0),
  tdtF16: model('parakeet-tdt-0.6b-v3.f16.gguf', REGISTRY_PREFIX_2026_07_01),
  eouQ4: model('parakeet-eou-120m-v1.q4_0.gguf', REGISTRY_PREFIX_Q4_0),
  eouQ8: model('parakeet-eou-120m-v1.q8_0.gguf', REGISTRY_PREFIX_Q8_0),
  eouF16: model('parakeet-eou-120m-v1.f16.gguf', REGISTRY_PREFIX_2026_07_01),
  sortformerQ4: model('sortformer-4spk-v1.q4_0.gguf', REGISTRY_PREFIX_Q4_0),
  sortformerQ8: model('sortformer-4spk-v1.q8_0.gguf', REGISTRY_PREFIX_Q8_0),
  sortformerF16: model('sortformer-4spk-v1.f16.gguf', REGISTRY_PREFIX_2026_07_01),
  sortformerStreamingQ4: model('diar_streaming_sortformer_4spk-v2.1.q4_0.gguf', REGISTRY_PREFIX_STREAMING),
  sortformerStreamingQ8: model('diar_streaming_sortformer_4spk-v2.1.q8_0.gguf', REGISTRY_PREFIX_STREAMING)
}

// Keyed by the mobile RUNNER FUNCTION NAME exported from
// test/mobile/integration.auto.cjs — scripts/generate-prestage-block.js looks
// each shard's Mocha grep up in this manifest, so a key that does not match an
// exported runner stages ZERO models for that shard and the test silently falls
// back to a 600 MB-class on-device download.
//
// All parakeet test files carry a `parakeet-` filename prefix in the unified
// package (whisper's kept the unprefixed names), so every runner here is
// `runParakeet…`. Do not drop the prefix when porting entries from the retired
// transcription-parakeet package. scripts/validate-mobile-tests.js enforces
// that every key below is an exported runner.
//
// Whisper models are deliberately absent: whisper's mobile tests resolve
// ggml-tiny + silero-vad on-device via test/integration/helpers.js, as in the
// whisper parent lane.
const TEST_MODELS = {
  runParakeetAccuracyMultilangTest: [MODELS.tdtQ4],
  runParakeetAddonMultimodelTest: [MODELS.ctcQ4, MODELS.eouQ4, MODELS.sortformerQ4],
  runParakeetColdStartTimingTest: [MODELS.tdtQ4],
  runParakeetDuplexStreamingEouTest: [MODELS.eouQ4],
  runParakeetDuplexStreamingTest: [MODELS.tdtQ4],
  runParakeetEouStreamingTest: [MODELS.eouQ4],
  runParakeetGpuSmokeTest: [MODELS.tdtQ4],
  runParakeetLiveStreamSimulationTest: [MODELS.tdtQ4],
  runParakeetMobilePerfCtcCpuTest: [MODELS.ctcQ4, MODELS.ctcQ8, MODELS.ctcF16],
  runParakeetMobilePerfCtcGpuTest: [MODELS.ctcQ4, MODELS.ctcQ8, MODELS.ctcF16],
  runParakeetMobilePerfEouCpuTest: [MODELS.eouQ4, MODELS.eouQ8, MODELS.eouF16],
  runParakeetMobilePerfEouGpuTest: [MODELS.eouQ4, MODELS.eouQ8, MODELS.eouF16],
  runParakeetMobilePerfSortformerCpuTest: [MODELS.sortformerQ4, MODELS.sortformerQ8, MODELS.sortformerF16],
  runParakeetMobilePerfSortformerGpuTest: [MODELS.sortformerQ4, MODELS.sortformerQ8, MODELS.sortformerF16],
  runParakeetMobilePerfSortformerStreamingCpuTest: [MODELS.sortformerStreamingQ4, MODELS.sortformerStreamingQ8],
  runParakeetMobilePerfSortformerStreamingGpuTest: [MODELS.sortformerStreamingQ4, MODELS.sortformerStreamingQ8],
  runParakeetMobilePerfTdtCpuTest: [MODELS.tdtQ4, MODELS.tdtQ8, MODELS.tdtF16],
  runParakeetMobilePerfTdtGpuTest: [MODELS.tdtQ4, MODELS.tdtQ8, MODELS.tdtF16],
  runParakeetMultipleTranscriptionsTest: [MODELS.tdtQ4],
  runParakeetSortformerAoscStreamingTest: [MODELS.sortformerStreamingQ4]
}

function model (name, prefix) {
  return { name, s3Key: `${prefix}/${name}` }
}

function presignModel (bucket, entry, expiresIn) {
  const url = execFileSync('aws', [
    's3',
    'presign',
    `s3://${bucket}/${entry.s3Key}`,
    '--expires-in',
    expiresIn
  ], { encoding: 'utf8' }).trim()

  return { name: entry.name, url }
}

function main () {
  const bucket = process.env.MODEL_S3_BUCKET
  if (!bucket) {
    throw new Error('MODEL_S3_BUCKET env var is required')
  }

  const expiresIn = process.env.MODEL_MANIFEST_EXPIRES_IN || DEFAULT_EXPIRES_IN
  const signed = new Map()
  const manifest = {}

  for (const [testName, entries] of Object.entries(TEST_MODELS)) {
    manifest[testName] = entries.map((entry) => {
      if (!signed.has(entry.name)) {
        signed.set(entry.name, presignModel(bucket, entry, expiresIn))
      }
      return signed.get(entry.name)
    })
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`Wrote ${outputPath} with ${signed.size} presigned model URL(s)`)
}

main()
