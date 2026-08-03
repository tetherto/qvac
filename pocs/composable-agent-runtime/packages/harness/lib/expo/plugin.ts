import {
  createRunOncePlugin,
  withDangerousMod,
  withRunOnce,
  type ConfigPlugin,
  type ExportedConfigWithProps
} from '@expo/config-plugins'
import type { ExpoConfig } from '@expo/config-types'
import { buildHarnessReactNativeBundle } from '../react-native-stow.ts'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeHarnessContribution } from './contribution.ts'
import { finalizeHarnessStandalone } from './finalize.ts'
import type { CreateHarnessExpoPluginOptions, HarnessBuildResult } from './types.ts'

const pluginId = '@qvac/harness/expo-plugin'
const buildRunOnceId = '@qvac/harness/expo-plugin/build'

export function createHarnessExpoPlugin(
  options: CreateHarnessExpoPluginOptions = {}
): ConfigPlugin {
  const mode = options.mode ?? 'standalone'
  const build = options.build ?? buildHarnessReactNativeBundle
  const packageVersion = options.packageVersion ?? readHarnessPackageVersion()
  const buildCache = new Map<string, Promise<HarnessBuildResult>>()
  const composeCache = new Map<string, Promise<void>>()
  const runOncePlugin = createRunOncePlugin(withHarnessExpoPlugin, pluginId, packageVersion)
  return runOncePlugin

  function withHarnessExpoPlugin(config: ExpoConfig) {
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
      const contribution = await composeHarnessContribution(projectRoot, result, { packageVersion })
      if (mode === 'standalone') await finalizeHarnessStandalone(projectRoot, contribution)
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
  build: () => Promise<HarnessBuildResult>,
  cache: Map<string, Promise<HarnessBuildResult>>
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

function readHarnessPackageVersion() {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const packageRoot =
    path.basename(moduleDirectory) === 'dist'
      ? path.dirname(moduleDirectory)
      : path.resolve(moduleDirectory, '../..')
  const require = createRequire(import.meta.url)
  const packageJson = require(path.join(packageRoot, 'package.json')) as { version?: string }
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('Harness package version is required for Expo plugin.')
  }
  return packageJson.version
}
