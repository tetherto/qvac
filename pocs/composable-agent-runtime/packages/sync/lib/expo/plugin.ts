import {
  createRunOncePlugin,
  withDangerousMod,
  withRunOnce,
  type ConfigPlugin,
  type ExportedConfigWithProps
} from '@expo/config-plugins'
import type { ExpoConfig } from '@expo/config-types'
import { buildSyncReactNativeBundle } from '../react-native-stow.ts'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeSyncContribution } from './contribution.ts'
import { finalizeSyncStandalone } from './finalize.ts'
import type { CreateSyncExpoPluginOptions, SyncBuildResult } from './types.ts'

const pluginId = '@qvac/sync/expo-plugin'
const buildRunOnceId = '@qvac/sync/expo-plugin/build'

export function createSyncExpoPlugin(options: CreateSyncExpoPluginOptions = {}): ConfigPlugin {
  const mode = options.mode ?? 'standalone'
  const build = options.build ?? buildSyncReactNativeBundle
  const packageVersion = options.packageVersion ?? readSyncPackageVersion()
  const buildCache = new Map<string, Promise<SyncBuildResult>>()
  const composeCache = new Map<string, Promise<void>>()
  const runOncePlugin = createRunOncePlugin(withSyncExpoPlugin, pluginId, packageVersion)
  return runOncePlugin

  function withSyncExpoPlugin(config: ExpoConfig) {
    return withRunOnce(config, {
      name: buildRunOnceId,
      version: packageVersion,
      plugin(configValue) {
        configValue = withDangerousMod(configValue, [
          'android',
          async (context) => {
            await composeOnce(context)
            return context
          }
        ])
        configValue = withDangerousMod(configValue, [
          'ios',
          async (context) => {
            await composeOnce(context)
            return context
          }
        ])
        return configValue
      }
    })
  }

  async function composeOnce(context: ExportedConfigWithProps<unknown>) {
    const projectRoot = readProjectRoot(context)
    const existing = composeCache.get(projectRoot)
    if (existing) return existing
    const work = (async () => {
      const result = await getOrCreateBuild(projectRoot, build, buildCache)
      const contribution = await composeSyncContribution(projectRoot, result, { packageVersion })
      if (mode === 'standalone') await finalizeSyncStandalone(projectRoot, contribution)
    })().catch((error: unknown) => {
      composeCache.delete(projectRoot)
      throw error
    })
    composeCache.set(projectRoot, work)
    return work
  }
}

function getOrCreateBuild(
  projectRoot: string,
  build: () => Promise<SyncBuildResult>,
  cache: Map<string, Promise<SyncBuildResult>>
) {
  const existing = cache.get(projectRoot)
  if (existing) return existing
  const created = build().catch((error: unknown) => {
    cache.delete(projectRoot)
    throw error
  })
  cache.set(projectRoot, created)
  return created
}

function readProjectRoot(context: ExportedConfigWithProps<unknown>) {
  const projectRoot = context.modRequest.projectRoot
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new Error('Expo plugin modRequest.projectRoot was missing')
  }
  return projectRoot
}

function readSyncPackageVersion() {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const packageRoot =
    path.basename(moduleDirectory) === 'dist'
      ? path.dirname(moduleDirectory)
      : path.resolve(moduleDirectory, '../..')
  const require = createRequire(import.meta.url)
  const packageJson = require(path.join(packageRoot, 'package.json')) as { version?: string }
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('Sync package version is required for Expo plugin.')
  }
  return packageJson.version
}
