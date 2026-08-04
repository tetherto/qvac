import {
  pluginDefinitionRuntimeSchema,
  type QvacPlugin,
  type PluginHandlerDefinition
} from '@/schemas/plugin'
import { isModelTypeAlias } from '@/schemas'
import {
  PluginAlreadyRegisteredError,
  PluginDefinitionInvalidError,
  PluginLoggingInvalidError,
  PluginModelTypeReservedError
} from '@/utils/errors-server'
import { createAddonLoggerCallback } from '@/logging/addon'
import { getServerLogger } from '@/logging'
import { formatZodError } from '@/utils/zod-error'

const plugins = new Map<string, QvacPlugin>()

interface PluginLoggingModule {
  setLogger: (callback: (priority: number, message: string) => void) => void
  releaseLogger?: () => void
}

function getLoggingModule(plugin: QvacPlugin) {
  return plugin.logging?.module as PluginLoggingModule | undefined
}

function findPluginUsingLoggingModule(loggingModule: PluginLoggingModule) {
  return Array.from(plugins.values()).find((plugin) => plugin.logging?.module === loggingModule)
}

function getModelTypeForError(plugin: unknown) {
  if (!plugin || typeof plugin !== 'object') return '(unknown)'
  if (!('modelType' in plugin)) return '(unknown)'
  const modelType = (plugin as { modelType?: unknown }).modelType
  return typeof modelType === 'string' && modelType.length > 0 ? modelType : '(unknown)'
}

function validatePluginDefinition(plugin: QvacPlugin): void {
  const result = pluginDefinitionRuntimeSchema.safeParse(plugin)
  if (result.success) return

  throw new PluginDefinitionInvalidError(getModelTypeForError(plugin), formatZodError(result.error))
}

export function registerPlugin(plugin: QvacPlugin): void {
  validatePluginDefinition(plugin)

  if (isModelTypeAlias(plugin.modelType)) {
    throw new PluginModelTypeReservedError(plugin.modelType)
  }

  if (plugins.has(plugin.modelType)) {
    throw new PluginAlreadyRegisteredError(plugin.modelType)
  }

  // Validate logging module shape if provided
  if (plugin.logging?.module) {
    const loggingModule = plugin.logging.module as Record<string, unknown>
    if (typeof loggingModule['setLogger'] !== 'function') {
      throw new PluginLoggingInvalidError(
        plugin.modelType,
        'logging.module must have a setLogger(callback) function'
      )
    }
  }

  const loggingModule = getLoggingModule(plugin)
  const pluginUsingLoggingModule = loggingModule
    ? findPluginUsingLoggingModule(loggingModule)
    : undefined
  if (
    pluginUsingLoggingModule &&
    pluginUsingLoggingModule.logging?.namespace !== plugin.logging?.namespace
  ) {
    throw new PluginLoggingInvalidError(
      plugin.modelType,
      'plugins sharing logging.module must use the same namespace'
    )
  }

  plugins.set(plugin.modelType, plugin)

  if (loggingModule && plugin.logging?.namespace && !pluginUsingLoggingModule) {
    loggingModule.setLogger(createAddonLoggerCallback(plugin.logging.namespace))
  }
}

export function registerPlugins(pluginList: readonly QvacPlugin[]): void {
  for (const plugin of pluginList) {
    registerPlugin(plugin)
  }
}

export function getPlugin(modelType: string): QvacPlugin | undefined {
  return plugins.get(modelType)
}

export function getPluginHandler(
  modelType: string,
  handlerName: string
): PluginHandlerDefinition | undefined {
  const plugin = plugins.get(modelType)
  if (!plugin) return undefined
  return plugin.handlers[handlerName]
}

export function hasPlugin(modelType: string): boolean {
  return plugins.has(modelType)
}

export function unregisterPlugin(modelType: string): boolean {
  const plugin = plugins.get(modelType)
  if (!plugin) return false

  const loggingModule = getLoggingModule(plugin)
  plugins.delete(modelType)
  if (loggingModule && !findPluginUsingLoggingModule(loggingModule)) {
    loggingModule.releaseLogger?.()
  }

  return true
}

export function getAllPlugins(): QvacPlugin[] {
  return Array.from(plugins.values())
}

export function clearPlugins(): void {
  const loggingModules = new Map<PluginLoggingModule, string>()
  for (const plugin of plugins.values()) {
    const loggingModule = getLoggingModule(plugin)
    if (loggingModule && !loggingModules.has(loggingModule)) {
      loggingModules.set(loggingModule, plugin.modelType)
    }
  }
  plugins.clear()
  for (const [loggingModule, modelType] of loggingModules) {
    try {
      loggingModule.releaseLogger?.()
    } catch (error) {
      // A plugin's logger teardown must not abort the sweep or leave the
      // registry half-cleared for the next caller — but surface it, so a leaked
      // reference or async handle is not masked as a clean teardown.
      getServerLogger().warn(
        `[${modelType}] releaseLogger failed during clearPlugins: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
}
