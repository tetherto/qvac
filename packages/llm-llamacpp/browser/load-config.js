// Mounted browser files cannot be memory-mapped, locked or opened with direct
// I/O. Preserve the native addon's alias validation, then select plain reads.
const LEGACY_LOAD_KEYS = [
  'mmap',
  'no-mmap',
  'no_mmap',
  'direct-io',
  'direct_io',
  'no-direct-io',
  'no_direct_io',
  'mlock'
]
const UNSUPPORTED_BROWSER_KEYS = [
  'rpc-servers',
  'rpc_servers',
  'rpc',
  'backendsDir',
  'openclCacheDir',
  'lora-scaled',
  'control-vector',
  'control-vector-scaled'
]
const FILE_KEYS = ['lora', 'spec-draft-model', 'spec_draft_model']

function browserLoadConfig(config = {}) {
  if (
    Object.prototype.hasOwnProperty.call(config, 'spec_draft_model') &&
    Object.prototype.hasOwnProperty.call(config, 'spec-draft-model')
  ) {
    throw new Error('spec_draft_model and spec-draft-model must not both be set')
  }

  for (const key of LEGACY_LOAD_KEYS) {
    if (config[key] !== undefined) {
      throw new Error(`${key} is not supported in the browser build; model files use plain reads`)
    }
  }

  for (const key of UNSUPPORTED_BROWSER_KEYS) {
    if (config[key] !== undefined) {
      throw new Error(`${key} is not supported in the browser build`)
    }
  }

  if (String(config.lora ?? '').includes(',')) {
    throw new Error('lora takes one adapter path in the browser build')
  }

  const { load_mode: underscore, 'load-mode': hyphen, ...rest } = config
  for (const [key, value] of [
    ['load_mode', underscore],
    ['load-mode', hyphen]
  ]) {
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`${key} must be a string`)
    }
  }
  if (
    underscore !== undefined &&
    hyphen !== undefined &&
    underscore.toLowerCase() !== hyphen.toLowerCase()
  ) {
    throw new Error('load-mode and load_mode must have the same value')
  }
  const requested = underscore ?? hyphen
  if (requested !== undefined && !['auto', 'none'].includes(requested.toLowerCase())) {
    throw new Error(`load_mode '${requested}' is not supported in the browser build`)
  }
  return Object.fromEntries([
    ...Object.entries(rest).map(([key, value]) => [key, String(value)]),
    ['load_mode', 'none']
  ])
}

async function mountLoadFiles(params, mountFile) {
  const config = browserLoadConfig(params.config)
  const mountedPaths = new Map()
  async function mountOnce(sourcePath) {
    if (!sourcePath) return ''
    if (!mountedPaths.has(sourcePath)) {
      mountedPaths.set(sourcePath, await mountFile(sourcePath))
    }
    return mountedPaths.get(sourcePath)
  }

  const modelPath = await mountOnce(params.path)
  const projectionPath = await mountOnce(params.projectionPath)
  for (const key of FILE_KEYS) {
    if (config[key]) config[key] = await mountOnce(config[key])
  }
  return { modelPath, projectionPath, config }
}

module.exports = { browserLoadConfig, mountLoadFiles }
