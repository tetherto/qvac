import configPlugins from '@expo/config-plugins'
import type { ExpoConfig } from 'expo/config'
import * as fs from 'fs'
import * as path from 'path'
import { bundleSdk } from '@/commands'
import { discardScratch, replaceAll, scratchFolderFor } from '@/commands/bundle/scratch'
import { CONFIG_CANDIDATES } from '@/client/config-loader/resolve-config.node'
import { resolveSDKPackageDir } from '@/expo/plugins/resolve-sdk-package-dir'
import { getProjectRootFromMod } from '@/expo/plugins/get-project-root'

const { withDangerousMod } = configPlugins

/** Modules to defer from mobile bundles (not available at bundle time) */
const DEFERRED_MODULES = ['expo-file-system', 'react-native-bare-kit']

type MobilePlatform = 'android' | 'ios'

const MOBILE_HOSTS_BY_PLATFORM: Record<MobilePlatform, string[]> = {
  android: ['android-arm64'],
  ios: ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator']
}

/** Every mobile host, in platform order. The bundle covers all of them. */
const MOBILE_HOSTS = [...MOBILE_HOSTS_BY_PLATFORM.android, ...MOBILE_HOSTS_BY_PLATFORM.ios]

/** The generated harness and its bundle, served as `@qvac/sdk/worker.mobile`. */
const WORKER_MOBILE_FILES = ['index.js', 'index.d.ts', 'index.bundle.mjs']

type MobileBundleOptions = {
  /**
   * Install the platform packages the app's split addons need for every
   * mobile host the bundle covers (both platforms: the bundle is shared) with
   * the app's package manager, pinned in package.json. Off by default:
   * `expo prebuild` then fails and names each package to add.
   */
  installMissingPrebuilds?: boolean
}

/**
 * Expo plugin: bundle and verify the worker, write Bare Kit and the native
 * addons for the platform being built, then copy the worker into the SDK.
 * Uses `qvac.config.*` if present.
 */
function withMobileBundle(config: ExpoConfig, options: MobileBundleOptions = {}): ExpoConfig {
  config = withDangerousMod(config, ['android', (mod) => buildMobileBundle(mod, options)])
  config = withDangerousMod(config, ['ios', (mod) => buildMobileBundle(mod, options)])
  return config
}

async function buildMobileBundle<T extends configPlugins.ExportedConfigWithProps<unknown>>(
  config: T,
  options: MobileBundleOptions
) {
  const projectRoot = getProjectRootFromMod(config)
  const sdkPackage = resolveSDKPackageDir(projectRoot)
  const platformHosts = mobileHostsForPlatform(config.modRequest.platform)

  const configPath = findConfigFile(projectRoot)
  if (configPath) {
    console.log(`🕚 QVAC: Found ${path.basename(configPath)}, generating tree-shaken bundle...`)
  } else {
    console.log('🕚 QVAC: No config found, generating default bundle (all plugins)...')
  }

  const deferredModules = [...DEFERRED_MODULES, `${sdkPackage.name}/worker.mobile`]
  // The bundle is one shared artifact both platforms import, so it is built
  // for every mobile host: a dual-platform `expo prebuild` runs this mod twice
  // and the second run would otherwise overwrite the first platform's bundle
  // with one that resolved the other platform's conditions.
  const result = await bundleSdk({
    projectRoot,
    sdkPath: sdkPackage.dir,
    ...(configPath ? { configPath } : {}),
    target: 'react-native',
    hosts: MOBILE_HOSTS,
    defer: deferredModules,
    quiet: true,
    installMissingPrebuilds: options.installMissingPrebuilds === true,
    link: platformHosts
  })
  if (result.installedPrebuilds.length > 0) {
    const names = result.installedPrebuilds.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')
    console.log(`📦 QVAC: Installed addon platform packages: ${names}`)
  }
  console.log(
    `🔗 QVAC: Linked ${result.linked.length} native addon files for ${platformHosts.join(', ')}`
  )

  await copyWorker(result.outputDir, path.join(sdkPackage.dir, 'dist', 'worker-mobile'))

  console.log('🫡 QVAC: Mobile bundle generated, verified and linked')
  return config
}

function mobileHostsForPlatform(platform: string) {
  if (platform !== 'android' && platform !== 'ios') {
    throw new Error(
      `QVAC: withMobileBundle only supports android and ios builds, got "${platform}"`
    )
  }
  return MOBILE_HOSTS_BY_PLATFORM[platform]
}

/** Finds qvac.config.* file in project root */
function findConfigFile(projectRoot: string): string | null {
  for (const candidate of CONFIG_CANDIDATES) {
    const configPath = path.join(projectRoot, candidate)
    if (fs.existsSync(configPath)) {
      return configPath
    }
  }
  return null
}

/** Copies the worker into `outDir`, which keeps its previous files until every copy is done. */
async function copyWorker(workerDir: string, outDir: string) {
  const scratch = await scratchFolderFor(outDir)
  try {
    fs.mkdirSync(scratch, { recursive: true })
    for (const file of WORKER_MOBILE_FILES) {
      fs.copyFileSync(path.join(workerDir, file), path.join(scratch, file))
    }
    await replaceAll([{ dir: outDir, next: scratch }])
  } finally {
    await discardScratch(scratch)
  }
}

export { MOBILE_HOSTS, MOBILE_HOSTS_BY_PLATFORM, buildMobileBundle, mobileHostsForPlatform }
export type { MobileBundleOptions, MobilePlatform }

export default withMobileBundle
