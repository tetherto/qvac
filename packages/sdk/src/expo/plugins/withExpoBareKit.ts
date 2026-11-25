import configPlugins from '@expo/config-plugins'
import type { ExpoConfig } from 'expo/config'
import * as fs from 'fs'
import * as path from 'path'
import semver from 'semver'
import { findInAncestorNodeModules } from '@/expo/plugins/find-in-ancestor-node-modules'
import { EXPO_BARE_KIT_ENTRY, qvacWorkerOptions } from '@/expo/plugins/mobile-worker'
import { buildMobileBundle, type MobileBundleOptions } from '@/expo/plugins/withMobileBundle'

const { withDangerousMod, withPlugins } = configPlugins

const EXPO_BARE_KIT = 'expo-bare-kit'

/** The first release that lets another plugin add a worker and choose the engine. */
const MIN_EXPO_BARE_KIT_VERSION = '0.3.1'

/** The expo-bare-kit the project installs, or null. */
function findExpoBareKit(projectRoot: string): string | null {
  return findInAncestorNodeModules(projectRoot, EXPO_BARE_KIT)
}

function assertExpoBareKitSupported(dir: string) {
  const { version } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof version === 'string' && semver.gte(version, MIN_EXPO_BARE_KIT_VERSION)) return
  throw new Error(
    `QVAC: expo-bare-kit ${String(version)} is installed, but @qvac/sdk/expo-plugin needs ` +
      `${MIN_EXPO_BARE_KIT_VERSION} or later to add the SDK worker to it. Upgrade expo-bare-kit.`
  )
}

/**
 * Expo plugin for apps that install expo-bare-kit: adds the SDK worker to
 * expo-bare-kit's workers, which links Bare Kit and the addons of every
 * worker once, and builds the worker entry it packs.
 */
function withExpoBareKit(
  config: ExpoConfig,
  options: MobileBundleOptions & { projectRoot: string; expoBareKitDir: string }
): ExpoConfig {
  const { projectRoot, expoBareKitDir, ...bundleOptions } = options
  assertExpoBareKitSupported(expoBareKitDir)

  config = withPlugins(config, [
    [EXPO_BARE_KIT, { workers: [[EXPO_BARE_KIT_ENTRY, qvacWorkerOptions(projectRoot)]] }]
  ])

  // A mod added later runs first, so the entry exists when expo-bare-kit links it.
  for (const platform of ['android', 'ios'] as const) {
    config = withDangerousMod(config, [
      platform,
      (mod) => buildMobileBundle(mod, bundleOptions, 'expo-bare-kit')
    ])
  }
  return config
}

export { MIN_EXPO_BARE_KIT_VERSION, findExpoBareKit }

export default withExpoBareKit
