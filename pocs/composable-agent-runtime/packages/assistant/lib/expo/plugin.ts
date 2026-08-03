import {
  createRunOncePlugin,
  withDangerousMod,
  withPlugins,
  withRunOnce,
  type ConfigPlugin,
  type ExportedConfigWithProps
} from '@expo/config-plugins'
import type { ExpoConfig } from '@expo/config-types'
import { createHarnessExpoPlugin } from '@qvac/harness/expo-plugin'
import sdkExpoPlugin from '@qvac/sdk/expo-plugin'
import { createSyncExpoPlugin } from '@qvac/sync/expo-plugin'
import { readAssistantPackageVersion } from '../packaging/addon-inventory.ts'
import { finalizeAssistantStack } from './finalize.ts'
import {
  ASSISTANT_FINALIZE_RUN_ONCE,
  ASSISTANT_PLUGIN_ID,
  HARNESS_PLUGIN_ID,
  SDK_PLUGIN_ID,
  SYNC_PLUGIN_ID,
  type ComposeAssistantStackOptions,
  type CreateAssistantExpoPluginOptions
} from './types.ts'

const ASSISTANT_PLUGIN_VERSION = readAssistantPackageVersion()

export async function composeAssistantStack(options: ComposeAssistantStackOptions) {
  await finalizeAssistantStack(options.projectRoot, {
    pinLinkerRoot: options.pinLinkerRoot === true,
    syncContribution: options.syncContribution,
    harnessContribution: options.harnessContribution
  })
}

export function createAssistantExpoPlugin(
  options: CreateAssistantExpoPluginOptions = {}
): ConfigPlugin {
  const sdkPlugin = options.sdkPlugin ?? (sdkExpoPlugin as ConfigPlugin)
  const syncPlugin =
    options.syncPlugin ??
    createSyncExpoPlugin({
      mode: 'contributor',
      build: options.syncBuild as never
    })
  const harnessPlugin =
    options.harnessPlugin ??
    createHarnessExpoPlugin({
      mode: 'contributor',
      build: options.harnessBuild as never
    })
  const finalizeCache = new Map<string, Promise<void>>()
  const runOncePlugin = createRunOncePlugin(
    withAssistantExpoPlugin,
    ASSISTANT_PLUGIN_ID,
    ASSISTANT_PLUGIN_VERSION
  )

  return runOncePlugin

  function withAssistantExpoPlugin(config: ExpoConfig) {
    assertNoDuplicatePluginRegistration(config.plugins, {
      sdkPlugin,
      syncPlugin,
      harnessPlugin,
      assistantRunOncePlugin: runOncePlugin,
      assistantPlugin: withAssistantExpoPlugin
    })
    // Expo dangerous mods execute in reverse registration order. Register finalizer
    // first and Sync last so actual execution is sync -> harness -> SDK -> finalizer.
    return withPlugins(config, [
      withRunOnceFinalizePlugin,
      sdkPlugin,
      harnessPlugin,
      syncPlugin
    ])
  }

  function withRunOnceFinalizePlugin(config: ExpoConfig) {
    return withRunOnce(config, {
      name: ASSISTANT_FINALIZE_RUN_ONCE,
      version: ASSISTANT_PLUGIN_VERSION,
      plugin(configValue) {
        configValue = withDangerousMod(configValue, [
          'android',
          async (context) => {
            await finalizeOnce(context)
            return context
          }
        ])
        configValue = withDangerousMod(configValue, [
          'ios',
          async (context) => {
            await finalizeOnce(context)
            return context
          }
        ])
        return configValue
      }
    })
  }

  async function finalizeOnce(context: ExportedConfigWithProps<unknown>) {
    const projectRoot = readProjectRoot(context)
    const existing = finalizeCache.get(projectRoot)
    if (existing) return existing
    const work = finalizeAssistantStack(projectRoot, { pinLinkerRoot: true }).catch(
      (error: unknown) => {
        finalizeCache.delete(projectRoot)
        throw error
      }
    )
    finalizeCache.set(projectRoot, work)
    return work
  }
}

function readProjectRoot(context: ExportedConfigWithProps<unknown>) {
  const projectRoot = context.modRequest.projectRoot
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new Error('Expo plugin modRequest.projectRoot was missing')
  }
  return projectRoot
}

function assertNoDuplicatePluginRegistration(
  plugins: readonly (unknown | [unknown, unknown])[] | undefined,
  options: {
    readonly sdkPlugin: ConfigPlugin
    readonly syncPlugin: ConfigPlugin
    readonly harnessPlugin: ConfigPlugin
    readonly assistantRunOncePlugin: ConfigPlugin
    readonly assistantPlugin: ConfigPlugin
  }
) {
  const entries = plugins ?? []

  if (entries.some((entry) => isMatchingPluginEntry(entry, SDK_PLUGIN_ID, options.sdkPlugin))) {
    throw new Error(
      'Duplicate SDK plugin registration detected. ' +
        'Use only @qvac/assistant/expo-plugin and remove @qvac/sdk/expo-plugin from app config.'
    )
  }
  if (entries.some((entry) => isMatchingPluginEntry(entry, SYNC_PLUGIN_ID, options.syncPlugin))) {
    throw new Error(
      'Duplicate Sync plugin registration detected. ' +
        'Use only @qvac/assistant/expo-plugin and remove @qvac/sync/expo-plugin from app config.'
    )
  }
  if (
    entries.some((entry) => isMatchingPluginEntry(entry, HARNESS_PLUGIN_ID, options.harnessPlugin))
  ) {
    throw new Error(
      'Duplicate Harness plugin registration detected. ' +
        'Use only @qvac/assistant/expo-plugin and remove @qvac/harness/expo-plugin from app config.'
    )
  }

  const assistantRegistrations = entries.filter((entry) =>
    isMatchingAssistantPluginEntry(
      entry,
      options.assistantRunOncePlugin,
      options.assistantPlugin
    )
  )
  if (assistantRegistrations.length > 1) {
    throw new Error('Duplicate plugin registration detected for @qvac/assistant/expo-plugin.')
  }
}

function isMatchingAssistantPluginEntry(
  entry: unknown,
  assistantRunOncePlugin: ConfigPlugin,
  assistantPlugin: ConfigPlugin
) {
  if (isMatchingPluginEntry(entry, ASSISTANT_PLUGIN_ID, assistantRunOncePlugin)) return true
  if (typeof entry === 'function') return entry === assistantPlugin
  if (!Array.isArray(entry)) return false
  const [plugin] = entry
  return typeof plugin === 'function' && plugin === assistantPlugin
}

function isMatchingPluginEntry(entry: unknown, pluginId: string, pluginFunction: ConfigPlugin) {
  if (typeof entry === 'string') {
    return entry === pluginId || entry.endsWith(pluginId)
  }
  if (typeof entry === 'function') return entry === pluginFunction
  if (!Array.isArray(entry) || entry.length === 0) return false
  const [plugin] = entry
  if (typeof plugin === 'string') {
    return plugin === pluginId || plugin.endsWith(pluginId)
  }
  return typeof plugin === 'function' && plugin === pluginFunction
}
