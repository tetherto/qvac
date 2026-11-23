import { mergeConfig } from '@/serve/core/fit'

/**
 * Config from `--set`: what applies to every model, and what applies to the
 * models one target names, a model or a model type.
 */
export interface FitSettings {
  all: Record<string, unknown>
  byTarget: Map<string, Record<string, unknown>>
}

export class FitSettingError extends Error {
  constructor(setting: string, reason: string) {
    super(`--set ${setting}: ${reason}`)
    this.name = 'FitSettingError'
  }
}

/**
 * Reads `--set` values of the form `[target:]key=value`, where the target is
 * a model or a model type. A dotted key nests, so `contextParams.n_ctx=4096`
 * sets `{ contextParams: { n_ctx: 4096 } }`. A value that parses as JSON is
 * taken as JSON, any other as a string.
 *
 * @throws {FitSettingError} When a value has no `=`, or names an empty target or key.
 */
export function parseSettings(settings: readonly string[]): FitSettings {
  const parsed: FitSettings = { all: {}, byTarget: new Map() }
  for (const setting of settings) {
    const equals = setting.indexOf('=')
    if (equals === -1) throw new FitSettingError(setting, 'expected [model:]key=value')

    const name = setting.slice(0, equals)
    // Keys never hold a colon, while an alias may (`qwen:8b`).
    const colon = name.lastIndexOf(':')
    const target = colon === -1 ? undefined : name.slice(0, colon)
    const path = name.slice(colon + 1).split('.')
    if (target === '' || path.some((part) => part === '')) {
      throw new FitSettingError(setting, 'empty model or key')
    }

    const value = nest(path, parseValue(setting.slice(equals + 1)))
    if (target === undefined) {
      parsed.all = mergeConfig(parsed.all, value)
    } else {
      parsed.byTarget.set(target, mergeConfig(parsed.byTarget.get(target) ?? {}, value))
    }
  }
  return parsed
}

/**
 * The config for one model: the settings for every model, then those for its
 * type over them, then its own over both.
 */
export function settingsFor(
  settings: FitSettings,
  model: string,
  modelType: string | undefined
): Record<string, unknown> {
  const forType = modelType === undefined ? {} : (settings.byTarget.get(modelType) ?? {})
  return mergeConfig(mergeConfig(settings.all, forType), settings.byTarget.get(model) ?? {})
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function nest(path: readonly string[], value: unknown): Record<string, unknown> {
  let nested = value
  for (let i = path.length - 1; i >= 0; i--) nested = { [path[i]!]: nested }
  return nested as Record<string, unknown>
}
