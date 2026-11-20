import {
  ModelTypeAliases,
  normalizeModelType,
  type CanonicalModelType
} from '@/schemas/model-types'
import { inferModelTypeFromModelSrc } from '@/schemas/model-src-utils'

export type LegacyModelConfigs = {}

type CanonicalOf<T> = T extends keyof typeof ModelTypeAliases ? (typeof ModelTypeAliases)[T] : T

export type LegacyModelConfigOf<T> =
  CanonicalOf<T> extends keyof LegacyModelConfigs ? LegacyModelConfigs[CanonicalOf<T>] : unknown

export type WithLegacyModelConfig<O> = O extends { modelType: infer T; modelConfig?: infer C }
  ? Omit<O, 'modelConfig'> & { modelConfig?: C & LegacyModelConfigOf<T> }
  : O

export type LegacyKeySpec = {
  readonly renames?: Readonly<Record<string, string>>
  readonly nested?: Readonly<Record<string, LegacyKeySpec>>
}

export type LegacyKeyWarn = (legacyPath: string, replacementPath: string) => void

export const LEGACY_MODEL_CONFIG_KEYS: Partial<Record<CanonicalModelType, LegacyKeySpec>> = {}

export const LEGACY_REQUEST_KEYS: Readonly<Record<string, LegacyKeySpec>> = {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function joinPath(prefix: string, key: string) {
  return prefix === '' ? key : `${prefix}.${key}`
}

function renameObject(
  value: Record<string, unknown>,
  spec: LegacyKeySpec,
  warn: LegacyKeyWarn,
  path: string
): Record<string, unknown> {
  let result = value
  for (const [legacyKey, key] of Object.entries(spec.renames ?? {})) {
    if (!(legacyKey in result)) continue
    if (result === value) result = { ...value }
    if (!(key in result)) result[key] = result[legacyKey]
    delete result[legacyKey]
    warn(joinPath(path, legacyKey), joinPath(path, key))
  }
  for (const [key, childSpec] of Object.entries(spec.nested ?? {})) {
    const child = result[key]
    const renamed = renameLegacyKeys(child, childSpec, warn, joinPath(path, key))
    if (renamed === child) continue
    if (result === value) result = { ...value }
    result[key] = renamed
  }
  return result
}

export function renameLegacyKeys<T>(
  value: T,
  spec: LegacyKeySpec,
  warn: LegacyKeyWarn,
  path = ''
): T {
  if (Array.isArray(value)) {
    let changed = false
    const items = value.map((item, index) => {
      const renamed = renameLegacyKeys(item, spec, warn, `${path}[${index}]`)
      if (renamed !== item) changed = true
      return renamed
    })
    return (changed ? items : value) as T
  }
  if (!isPlainObject(value)) return value
  return renameObject(value, spec, warn, path) as T
}

export function renameLegacyModelConfigKeys<T>(
  modelType: unknown,
  modelConfig: T,
  warn: LegacyKeyWarn,
  path = 'modelConfig'
): T {
  if (typeof modelType !== 'string') return modelConfig
  const spec = LEGACY_MODEL_CONFIG_KEYS[normalizeModelType(modelType) as CanonicalModelType]
  return spec ? renameLegacyKeys(modelConfig, spec, warn, path) : modelConfig
}

function renameLoadModelConfig<T extends Record<string, unknown>>(
  load: T,
  warn: LegacyKeyWarn,
  path: string
): T {
  if (!('modelConfig' in load)) return load
  const modelConfig = renameLegacyModelConfigKeys(
    load['modelType'] ?? inferModelTypeFromModelSrc(load['modelSrc']),
    load['modelConfig'],
    warn,
    joinPath(path, 'modelConfig')
  )
  return modelConfig === load['modelConfig'] ? load : { ...load, modelConfig }
}

export function renameLegacyRequestKeys<T>(request: T, warn: LegacyKeyWarn): T {
  if (!isPlainObject(request)) return request
  let result: Record<string, unknown> = request
  const type = result['type']

  if (type === 'loadModel') {
    result = renameLoadModelConfig(result, warn, '')
  } else if (type === 'assessModelFit' && Array.isArray(result['models'])) {
    const models = result['models'] as unknown[]
    const renamed = models.map((load, index) =>
      isPlainObject(load) ? renameLoadModelConfig(load, warn, `models[${index}]`) : load
    )
    if (renamed.some((load, index) => load !== models[index])) {
      result = { ...result, models: renamed }
    }
  }

  const spec = typeof type === 'string' ? LEGACY_REQUEST_KEYS[type] : undefined
  if (spec) result = renameLegacyKeys(result, spec, warn)
  return result as T
}

function renamePatternDefaults(
  defaults: Record<string, unknown>,
  warn: LegacyKeyWarn,
  path: string
): Record<string, unknown> {
  let result = defaults
  for (const [modelType, modelConfig] of Object.entries(defaults)) {
    const renamed = renameLegacyModelConfigKeys(
      modelType,
      modelConfig,
      warn,
      `${path}.${modelType}`
    )
    if (renamed === modelConfig) continue
    if (result === defaults) result = { ...defaults }
    result[modelType] = renamed
  }
  return result
}

export function renameLegacyConfigKeys<T>(config: T, warn: LegacyKeyWarn): T {
  if (!isPlainObject(config) || !Array.isArray(config['deviceDefaults'])) return config
  const patterns = config['deviceDefaults'] as unknown[]
  const renamed = patterns.map((pattern, index) => {
    if (!isPlainObject(pattern) || !isPlainObject(pattern['defaults'])) return pattern
    const defaults = renamePatternDefaults(
      pattern['defaults'],
      warn,
      `deviceDefaults[${index}].defaults`
    )
    return defaults === pattern['defaults'] ? pattern : { ...pattern, defaults }
  })
  const changed = renamed.some((pattern, index) => pattern !== patterns[index])
  return (changed ? { ...config, deviceDefaults: renamed } : config) as T
}

export function createLegacyKeyWarner(log: (message: string) => void): LegacyKeyWarn {
  const warned = new Set<string>()
  return (legacyPath, replacementPath) => {
    const pathWithoutIndexes = legacyPath.replace(/\[\d+\]/g, '[]')
    if (warned.has(pathWithoutIndexes)) return
    warned.add(pathWithoutIndexes)
    log(
      `"${legacyPath}" is deprecated and will be removed in the next release. Use "${replacementPath}" instead.`
    )
  }
}
