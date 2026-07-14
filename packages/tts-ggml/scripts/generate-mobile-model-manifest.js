'use strict'

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const DEFAULT_EXPIRES_IN = '604800'
const outputPath = path.resolve(__dirname, '../test/mobile/testAssets/model-manifest.json')

function model (name, s3Key, targetName) {
  return { name, s3Key, targetName: targetName || name }
}

const Q4_MODELS = [
  model(
    'chatterbox-t3-turbo-q4_0.gguf',
    'qvac_models_compiled/ggml/chatterbox/2026-05-18/chatterbox-t3-turbo-q4_0.gguf',
    'chatterbox-t3-turbo.gguf'
  ),
  model(
    'chatterbox-s3gen-q4_0.gguf',
    'qvac_models_compiled/ggml/chatterbox/2026-06-01/chatterbox-s3gen-q4_0.gguf',
    'chatterbox-s3gen.gguf'
  ),
  model(
    'chatterbox-t3-mtl-q4_0.gguf',
    'qvac_models_compiled/ggml/chatterbox/2026-05-18/chatterbox-t3-mtl-q4_0.gguf',
    'chatterbox-t3-mtl.gguf'
  ),
  model(
    'chatterbox-s3gen-mtl-q4_0.gguf',
    'qvac_models_compiled/ggml/chatterbox/2026-06-01/chatterbox-s3gen-mtl-q4_0.gguf',
    'chatterbox-s3gen-mtl.gguf'
  ),
  model(
    'supertonic-q4_0.gguf',
    'qvac_models_compiled/ggml/supertonic/2026-05-18/supertonic-q4_0.gguf',
    'supertonic.gguf'
  ),
  model(
    'supertonic2-q4_0.gguf',
    'qvac_models_compiled/ggml/supertonic/2026-05-18/supertonic2-q4_0.gguf',
    'supertonic2.gguf'
  ),
  // Supertonic 3 encodes the quant in the on-disk name (unlike v1/v2), so the
  // target keeps the quant-tagged filename that ensureSupertonic3Model expects.
  model(
    'supertonic3-q4_0.gguf',
    'qvac_models_compiled/ggml/supertonic/2026-06-15/supertonic3-q4_0.gguf',
    'supertonic3-q4_0.gguf'
  )
]

const Q8_MODELS = [
  model(
    'chatterbox-t3-turbo-q8_0.gguf',
    'qvac_models_compiled/ggml/chatterbox/2026-05-18/chatterbox-t3-turbo-q8_0.gguf',
    'chatterbox-t3-turbo.gguf'
  ),
  model(
    'chatterbox-s3gen-q8_0.gguf',
    'qvac_models_compiled/ggml/chatterbox/2026-06-01/chatterbox-s3gen-q8_0.gguf',
    'chatterbox-s3gen.gguf'
  ),
  model(
    'chatterbox-t3-mtl-q8_0.gguf',
    'qvac_models_compiled/ggml/chatterbox/2026-05-18/chatterbox-t3-mtl-q8_0.gguf',
    'chatterbox-t3-mtl.gguf'
  ),
  model(
    'chatterbox-s3gen-mtl-q8_0.gguf',
    'qvac_models_compiled/ggml/chatterbox/2026-06-01/chatterbox-s3gen-mtl-q8_0.gguf',
    'chatterbox-s3gen-mtl.gguf'
  ),
  model(
    'supertonic-q8_0.gguf',
    'qvac_models_compiled/ggml/supertonic/2026-05-18/supertonic-q8_0.gguf',
    'supertonic.gguf'
  ),
  model(
    'supertonic2-q8_0.gguf',
    'qvac_models_compiled/ggml/supertonic/2026-05-18/supertonic2-q8_0.gguf',
    'supertonic2.gguf'
  )
]

function presignModel (bucket, entry, expiresIn) {
  const url = execFileSync(
    'aws',
    ['s3', 'presign', `s3://${bucket}/${entry.s3Key}`, '--expires-in', expiresIn],
    { encoding: 'utf8' }
  ).trim()
  return {
    name: entry.name,
    targetName: entry.targetName,
    url
  }
}

function main () {
  const bucket = process.env.MODEL_S3_BUCKET
  if (!bucket) {
    throw new Error('MODEL_S3_BUCKET env var is required')
  }

  const expiresIn = process.env.MODEL_MANIFEST_EXPIRES_IN || DEFAULT_EXPIRES_IN
  const signed = new Map()

  const manifest = {
    q4: Q4_MODELS.map((entry) => {
      if (!signed.has(entry.name)) signed.set(entry.name, presignModel(bucket, entry, expiresIn))
      return signed.get(entry.name)
    }),
    q8: Q8_MODELS.map((entry) => {
      if (!signed.has(entry.name)) signed.set(entry.name, presignModel(bucket, entry, expiresIn))
      return signed.get(entry.name)
    })
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`Wrote ${outputPath} with ${signed.size} presigned model URL(s)`)
}

main()
