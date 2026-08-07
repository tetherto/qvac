'use strict'

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const DEFAULT_EXPIRES_IN = '604800'
const outputPath = path.resolve(__dirname, '../test/mobile/testAssets/model-manifest.json')

function model(name, s3Key, targetName) {
  return { name, s3Key, targetName: targetName || name }
}

function publicModel(name, url, targetName) {
  return { name, url, targetName: targetName || name }
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

const FUNCTIONAL_MODELS = [
  model(
    'supertonic3-f16.gguf',
    'qvac_models_compiled/ggml/supertonic/2026-06-10/supertonic3-f16.gguf'
  ),
  model(
    'supertonic3-f32.gguf',
    'qvac_models_compiled/ggml/supertonic/2026-06-10/supertonic3-f32.gguf'
  ),
  model(
    'supertonic3-q8_0.gguf',
    'qvac_models_compiled/ggml/supertonic/2026-06-15/supertonic3-q8_0.gguf'
  ),
  model(
    'supertonic3-q4_0.gguf',
    'qvac_models_compiled/ggml/supertonic/2026-06-15/supertonic3-q4_0.gguf'
  )
]

// LavaSR enhancer + denoiser are orthogonal to the engine quant (q4/q8): the
// benchmark's `enhancer`/`denoiser=lavasr` rows layer them on any engine. Only
// the published fp16 tier is pre-staged for mobile (the enhancer quant-tier
// sweep is desktop-only). The target keeps the on-disk names the on-device
// resolver expects under a `lavasr/` subdir (ensureLavaSR*Gguf scans
// <modelsDir>/lavasr), so they never collide with the flat engine GGUFs.
// The registry dates below must match REGISTRY_DATE_LAVASR /
// REGISTRY_DATE_LAVASR_DENOISER in test/utils/downloadModel.js (the resolver that
// fetches the same GGUFs); generate-mobile-model-manifest.test.js pins them so a
// drift fails there, since this Node script can't require that Bare-only module.
const LAVASR_MODELS = [
  model(
    'lavasr-enhancer-f16.gguf',
    'qvac_models_compiled/ggml/lavasr/2026-06-26/lavasr-enhancer-f16.gguf',
    'lavasr/lavasr-enhancer.gguf'
  ),
  model(
    'lavasr-denoiser-f16.gguf',
    'qvac_models_compiled/ggml/lavasr/2026-07-03/lavasr-denoiser-f16.gguf',
    'lavasr/lavasr-denoiser.gguf'
  )
]

// CosyVoice3 consumes a whole directory (LLM + flow + hift GGUFs + tokenizer +
// voice), so the whole group is staged under a `cosyvoice3/` subdir on device
// (like LavaSR's `lavasr/` subdir) — the on-device resolver (ensureCosyvoiceModel)
// scans <modelsDir>/cosyvoice3. Unlike the q4/q8 engines this group is quant-fixed
// (the LLM is q8_0, flow/hift are f32), so the prestage cosyvoice branch ignores
// the row's variant. `vocab.json`/`merges.txt` are plain S3 objects (not GGUFs)
// but the same `model()` presign helper works. The registry file `voice-en.gguf`
// is staged as `voice.gguf`, the name the engine's model_dir resolves. The date
// below must match REGISTRY_DATE_COSYVOICE in test/utils/downloadModel.js (the
// on-device resolver); generate-mobile-model-manifest.test.js pins it so a drift
// fails there, since this Node script can't require that Bare-only module.
const COSYVOICE_MODELS = [
  model(
    'cosyvoice3-llm-q8_0.gguf',
    'qvac_models_compiled/ggml/cosy_voice/2026-07-23/cosyvoice3-llm-q8_0.gguf',
    'cosyvoice3/cosyvoice3-llm-q8_0.gguf'
  ),
  model(
    'cosyvoice3-flow-f32.gguf',
    'qvac_models_compiled/ggml/cosy_voice/2026-07-23/cosyvoice3-flow-f32.gguf',
    'cosyvoice3/cosyvoice3-flow-f32.gguf'
  ),
  model(
    'cosyvoice3-hift-f32.gguf',
    'qvac_models_compiled/ggml/cosy_voice/2026-07-23/cosyvoice3-hift-f32.gguf',
    'cosyvoice3/cosyvoice3-hift-f32.gguf'
  ),
  // Registry file is `voice-en.gguf`; the engine resolves `voice.gguf`, so the
  // target keeps the on-device name ensureCosyvoiceModel expects.
  model(
    'voice-en.gguf',
    'qvac_models_compiled/ggml/cosy_voice/2026-07-23/voice-en.gguf',
    'cosyvoice3/voice.gguf'
  ),
  model(
    'vocab.json',
    'qvac_models_compiled/ggml/cosy_voice/2026-07-23/vocab.json',
    'cosyvoice3/vocab.json'
  ),
  model(
    'merges.txt',
    'qvac_models_compiled/ggml/cosy_voice/2026-07-23/merges.txt',
    'cosyvoice3/merges.txt'
  )
]

const QUALITY_MODELS = [
  publicModel(
    'ggml-tiny.bin',
    'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin',
    'whisper/ggml-tiny.bin'
  )
]

function presignModel(bucket, entry, expiresIn) {
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

// Sign each model once (by name, so a GGUF shared across q4/q8 is only signed
// once) via the injected `presign`. Injecting it keeps the manifest shape
// unit-testable without shelling out to `aws`.
function buildManifest(presign) {
  const signed = new Map()
  const signOnce = (entry) => {
    if (!signed.has(entry.name)) signed.set(entry.name, presign(entry))
    return signed.get(entry.name)
  }
  const manifest = {
    q4: Q4_MODELS.map(signOnce),
    q8: Q8_MODELS.map(signOnce),
    functional: FUNCTIONAL_MODELS.map(signOnce),
    lavasr: LAVASR_MODELS.map(signOnce),
    cosyvoice: COSYVOICE_MODELS.map(signOnce),
    quality: QUALITY_MODELS
  }
  return { manifest, signedCount: signed.size }
}

function main() {
  const bucket = process.env.MODEL_S3_BUCKET
  if (!bucket) {
    throw new Error('MODEL_S3_BUCKET env var is required')
  }

  const expiresIn = process.env.MODEL_MANIFEST_EXPIRES_IN || DEFAULT_EXPIRES_IN
  const { manifest, signedCount } = buildManifest((entry) => presignModel(bucket, entry, expiresIn))

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`Wrote ${outputPath} with ${signedCount} presigned model URL(s)`)
}

if (require.main === module) {
  main()
}

module.exports = {
  buildManifest,
  Q4_MODELS,
  Q8_MODELS,
  FUNCTIONAL_MODELS,
  LAVASR_MODELS,
  COSYVOICE_MODELS,
  QUALITY_MODELS
}
