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

const TEST_MODELS = {
  runAccuracyMultilangTest: [MODELS.tdtQ4],
  runAddonMultimodelTest: [MODELS.ctcQ4, MODELS.eouQ4, MODELS.sortformerQ4],
  runColdStartTimingTest: [MODELS.tdtQ4],
  runDuplexStreamingEouTest: [MODELS.eouQ4],
  runDuplexStreamingTest: [MODELS.tdtQ4],
  runEouStreamingTest: [MODELS.eouQ4],
  runGpuSmokeTest: [MODELS.tdtQ4],
  runLiveStreamSimulationTest: [MODELS.tdtQ4],
  runMobilePerfCtcCpuTest: [MODELS.ctcQ4, MODELS.ctcQ8, MODELS.ctcF16],
  runMobilePerfCtcGpuTest: [MODELS.ctcQ4, MODELS.ctcQ8, MODELS.ctcF16],
  runMobilePerfEouCpuTest: [MODELS.eouQ4, MODELS.eouQ8, MODELS.eouF16],
  runMobilePerfEouGpuTest: [MODELS.eouQ4, MODELS.eouQ8, MODELS.eouF16],
  runMobilePerfSortformerCpuTest: [MODELS.sortformerQ4, MODELS.sortformerQ8, MODELS.sortformerF16],
  runMobilePerfSortformerGpuTest: [MODELS.sortformerQ4, MODELS.sortformerQ8, MODELS.sortformerF16],
  runMobilePerfTdtCpuTest: [MODELS.tdtQ4, MODELS.tdtQ8, MODELS.tdtF16],
  runMobilePerfTdtGpuTest: [MODELS.tdtQ4, MODELS.tdtQ8, MODELS.tdtF16],
  runMultipleTranscriptionsTest: [MODELS.tdtQ4],
  runSortformerAoscStreamingTest: [MODELS.sortformerStreamingQ4]
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
