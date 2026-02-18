'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const {
  CTX_SIZES,
  BATCH_SIZES
} = require('./sweep-shared-constants')

const DEFAULT_RESULTS_DIR = path.resolve(__dirname, 'results', 'parameter-sweep')
const DEFAULT_MODELS_DIR = path.resolve(__dirname, 'models')
const MANIFEST_PATH = path.resolve(__dirname, 'models.manifest.json')
const RESOLVED_MODELS_PATH = path.resolve(__dirname, 'resolved-models.json')
const DEFAULT_PROMPTS_FILE = path.resolve(__dirname, 'test-prompts.json')
const DEFAULT_REPEATS = 5

// Benchmark baseline defaults
const BENCH_DEFAULT_RUNTIME = {
  device: 'gpu',
  'gpu-layers': '99',
  'ctx-size': '2048',
  verbosity: '0',
  'batch-size': '512',
  'ubatch-size': '512',
  'no-mmap': false,
  'flash-attn': 'off',
  temp: '0.1', // Override: addon default 0.8, using 0.1 for reproducibility
  seed: '42', // Override: addon default -1, using 42 for determinism
  'n-predict': '1024', // Override: addon default -1, using 1024 for long-output benchmarking
  'top-p': '0.9', // Addon default
  'top-k': '40', // Addon default
  'repeat-penalty': '1.1', // Addon default
  'presence-penalty': '0', // Addon default
  'frequency-penalty': '0' // Addon default
  // Not set (use llama.cpp defaults): threads, cache-type-k, cache-type-v, no-kv-offload
}

// Optional per-model runtime overrides for local testing
// Example: { 'qwen3-1.7b': { 'gpu-layers': '35' } }
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

// Parameter sweep: full factorial (cartesian product)
const PARAMETER_SWEEP = {
  quantization: ['Q4_0', 'Q4_K_M', 'Q8_0', 'F16'],
  device: ['cpu', 'gpu'],
  'ctx-size': CTX_SIZES.map(String),
  'no-mmap': [false, true],
  threads: ['2', '4', '8'],
  'batch-size': BATCH_SIZES.map(String), // max: 10k
  'ubatch-size': ['128', '512'], // must be <= batch-size
  'no-kv-offload': [false, true],
  'flash-attn': ['off', 'on'],
  'cache-type-k': ['f16', 'q8_0', 'q4_0'],
  'cache-type-v': ['f16', 'q8_0', 'q4_0']
  // verbosity: fixed at '0' (not swept)
}

module.exports = {
  DEFAULT_RESULTS_DIR,
  DEFAULT_MODELS_DIR,
  MANIFEST_PATH,
  RESOLVED_MODELS_PATH,
  DEFAULT_REPEATS,
  DEFAULT_PROMPTS_FILE,
  BENCH_DEFAULT_RUNTIME,
  MODEL_RUNTIME_OVERRIDES,
  MODELS,
  PARAMETER_SWEEP
}
