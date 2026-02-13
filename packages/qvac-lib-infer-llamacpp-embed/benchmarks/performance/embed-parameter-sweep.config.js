'use strict'

const fs = require('bare-fs')
const path = require('bare-path')

const DEFAULT_RESULTS_DIR = path.resolve(__dirname, 'results', 'parameter-sweep')
const DEFAULT_MODELS_DIR = path.resolve(__dirname, '..', '..', 'test', 'model')
const MANIFEST_PATH = path.resolve(__dirname, 'models.manifest.json')
const RESOLVED_MODELS_PATH = path.resolve(__dirname, 'resolved-models.json')
const DEFAULT_INPUTS_FILE = path.resolve(__dirname, 'mteb-inputs.json')
const DEFAULT_REPEATS = 3

// Benchmark-controlled runtime defaults used as the baseline reference.
const BENCH_DEFAULT_RUNTIME = {
  device: 'gpu',
  batchSize: 512,
  noMmap: false,
  flashAttn: 'off',
  verbosity: 0,
  ngl: 99
}

// Optional per-model runtime overrides. Only add entries when a model needs
// non-global defaults (for example because of VRAM limitations).
const MODEL_RUNTIME_OVERRIDES = {
}

function buildQuantizationFiles (manifestModel, resolvedModelEntry) {
  if (resolvedModelEntry && resolvedModelEntry.gguf && resolvedModelEntry.gguf.files) {
    const normalized = {}
    for (const [quantization, localPath] of Object.entries(resolvedModelEntry.gguf.files)) {
      normalized[quantization] = path.basename(localPath)
    }
    return normalized
  }
  return manifestModel.gguf.files || {}
}

function loadModelsFromManifest () {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  let resolved = null
  if (fs.existsSync(RESOLVED_MODELS_PATH)) {
    resolved = JSON.parse(fs.readFileSync(RESOLVED_MODELS_PATH, 'utf8'))
  }

  const manifestModels = manifest.models || []
  return manifestModels.map((model) => {
    const resolvedEntry = resolved && resolved.models ? resolved.models[model.id] : null
    const quantizationFiles = buildQuantizationFiles(model, resolvedEntry)
    const defaults = {
      ...BENCH_DEFAULT_RUNTIME,
      ...(MODEL_RUNTIME_OVERRIDES[model.id] || {})
    }
    return {
      id: model.id,
      source: `https://huggingface.co/${model.gguf.repo}`,
      modelDir: DEFAULT_MODELS_DIR,
      defaultQuantization: model.gguf.defaultQuantization,
      quantizationFiles,
      defaults
    }
  })
}

const MODELS = loadModelsFromManifest()

const PARAMETER_SWEEP = {
  quantization: ['Q4_0', 'F16'],
  device: ['cpu', 'gpu'],
  batchSize: [512, 1024],
  noMmap: [false, true],
  flashAttn: ['off', 'on'],
  verbosity: [0]
}

module.exports = {
  DEFAULT_RESULTS_DIR,
  DEFAULT_MODELS_DIR,
  MANIFEST_PATH,
  RESOLVED_MODELS_PATH,
  DEFAULT_REPEATS,
  DEFAULT_INPUTS_FILE,
  BENCH_DEFAULT_RUNTIME,
  MODEL_RUNTIME_OVERRIDES,
  MODELS,
  PARAMETER_SWEEP
}
