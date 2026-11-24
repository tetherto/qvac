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
const EXTERNAL_DRAFT_KEYS = ['spec-draft-model', 'spec_draft_model']
const UNSUPPORTED_BROWSER_KEYS = [
  'lora',
  'rpc-servers',
  'rpc_servers',
  'rpc',
  'backendsDir',
  'openclCacheDir'
]

function browserLoadConfig(config = {}) {
  for (const key of LEGACY_LOAD_KEYS) {
    if (config[key] !== undefined) {
      throw new Error(`${key} is not supported in the browser build; model files use plain reads`)
    }
  }

  for (const key of EXTERNAL_DRAFT_KEYS) {
    if (config[key] !== undefined && config[key] !== '') {
      throw new Error(`${key} is not supported in the browser build`)
    }
  }

  for (const key of UNSUPPORTED_BROWSER_KEYS) {
    if (config[key] !== undefined) {
      throw new Error(`${key} is not supported in the browser build`)
    }
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

module.exports = { browserLoadConfig }
