import { BUILTIN_PLUGINS, BUILTIN_SUFFIXES } from './constants.js'
import { InvalidPluginSpecifierError } from '../errors.js'
import type { Logger } from '../logger.js'

export function buildBuiltinSpecifier (sdkName: string, suffix: string): string {
  return `${sdkName}/${suffix}/plugin`
}

export function parseBuiltinSpecifier (specifier: string, sdkName: string): { suffix: string; exportName: string } | null {
  const prefix = `${sdkName}/`
  const pluginSuffix = '/plugin'

  if (specifier.startsWith(prefix) && specifier.endsWith(pluginSuffix)) {
    const middle = specifier.slice(prefix.length, -pluginSuffix.length)
    const info = BUILTIN_PLUGINS[middle]
    if (!middle.includes('/') && info) {
      return { suffix: middle, exportName: info.exportName }
    }
  }

  return null
}

export function resolvePluginSpecifiers (config: { plugins?: string[] }, sdkName: string, logger: Logger): string[] {
  let plugins = config.plugins ?? []

  if (plugins.length === 0) {
    const allBuiltins = BUILTIN_SUFFIXES.map((suffix) =>
      buildBuiltinSpecifier(sdkName, suffix)
    )
    logger.warn('No plugins specified — bundling ALL built-in plugins.')
    logger.info("   For smaller bundles, add a 'plugins' array to qvac.config.*\n")
    plugins = allBuiltins
  }

  const uniquePlugins = [...new Set(plugins)]

  const resolved: string[] = []
  const customPlugins: string[] = []
  const errors: string[] = []

  for (const specifier of uniquePlugins) {
    const builtin = parseBuiltinSpecifier(specifier, sdkName)
    if (builtin) {
      resolved.push(specifier)
    } else {
      if (!specifier.endsWith('/plugin')) {
        errors.push(specifier)
      } else {
        customPlugins.push(specifier)
      }
    }
  }

  if (errors.length > 0) {
    throw new InvalidPluginSpecifierError(errors)
  }

  if (customPlugins.length > 0) {
    logger.info(`📦 Custom plugins: ${customPlugins.join(', ')}`)
  }

  return [...resolved, ...customPlugins]
}
