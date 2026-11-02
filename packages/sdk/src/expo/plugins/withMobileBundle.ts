import configPlugins from '@expo/config-plugins'
import type { ExpoConfig } from 'expo/config'
import * as fs from 'fs'
import * as path from 'path'
import { bundleSdk, verifyBundle, hasErrors, formatVerifyBundleResult } from '@/commands'
import { createCommandLogger } from '@/commands/command-logger'
import { CONFIG_CANDIDATES } from '@/client/config-loader/resolve-config.node'
import { resolveSDKPackageDir } from '@/expo/plugins/resolve-sdk-package-dir'
import { getProjectRootFromMod } from '@/expo/plugins/get-project-root'
import { linkAddons } from '@/expo/plugins/link-addons'
import { BundleVerificationFailedError } from '@/utils/errors-client'

const { withDangerousMod } = configPlugins

/** Modules to defer from mobile bundles (not available at bundle time) */
const DEFERRED_MODULES = ['expo-file-system', 'react-native-bare-kit']

/**
 * Desktop-only spawn path. `bare-runtime` maps `process` to `bare-process`
 * under Bare, which pulls `bare-posix` (no `android-arm64` prebuild), so
 * bare-pack must not walk it.
 */
const MOBILE_UNSUPPORTED_MODULES = ['bare-runtime/spawn']

type MobilePlatform = 'android' | 'ios'

const MOBILE_HOSTS_BY_PLATFORM: Record<MobilePlatform, string[]> = {
  android: ['android-arm64'],
  ios: ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator']
}

/** Every mobile host, in platform order. The bundle covers all of them. */
const MOBILE_HOSTS = [...MOBILE_HOSTS_BY_PLATFORM.android, ...MOBILE_HOSTS_BY_PLATFORM.ios]

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
 * Expo plugin: bundles the worker for every mobile host, verifies it for the
 * platform being prebuilt, copies it to `<sdkPackageDir>/dist/worker.mobile.bundle.js`,
 * and links the native addons it loads into react-native-bare-kit. Uses
 * `qvac.config.*` if present.
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
  const outputPath = path.join(sdkPackage.dir, 'dist', 'worker.mobile.bundle.js')
  const platformHosts = mobileHostsForPlatform(config.modRequest.platform)

  const configPath = findConfigFile(projectRoot)
  if (configPath) {
    console.log(`🕚 QVAC: Found ${path.basename(configPath)}, generating tree-shaken bundle...`)
  } else {
    console.log('🕚 QVAC: No config found, generating default bundle (all plugins)...')
  }

  const deferredModules = [
    ...DEFERRED_MODULES,
    ...MOBILE_UNSUPPORTED_MODULES,
    `${sdkPackage.name}/worker.mobile.bundle`
  ]
  // The bundle is one shared artifact both platforms import, so it is built
  // for every mobile host: a dual-platform `expo prebuild` runs this mod twice
  // and the second run would otherwise overwrite the first platform's bundle
  // with one that resolved the other platform's conditions.
  const entryPath = await runBundler(
    projectRoot,
    sdkPackage.dir,
    configPath,
    deferredModules,
    MOBILE_HOSTS,
    options.installMissingPrebuilds === true
  )
  const generatedBundle = path.join(projectRoot, 'qvac', 'worker.bundle.js')

  await runVerifier(projectRoot, generatedBundle, configPath, platformHosts)

  fs.copyFileSync(generatedBundle, outputPath)

  const linked = await linkAddons({
    projectRoot,
    entryPath,
    hosts: platformHosts,
    logger: createCommandLogger({})
  })
  console.log(`🔗 QVAC: Linked ${linked.length} native addon files for ${platformHosts.join(', ')}`)

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

async function runVerifier(
  projectRoot: string,
  generatedBundle: string,
  configPath: string | null,
  hosts: string[]
) {
  const result = await verifyBundle({
    projectRoot,
    addonsSource: generatedBundle,
    hosts,
    ...(configPath ? { configPath } : {}),
    onProgress: (message) => console.log(`🕚 QVAC: ${message}`)
  })

  if (hasErrors(result)) {
    throw new BundleVerificationFailedError(
      generatedBundle,
      new Error(formatVerifyBundleResult(result))
    )
  }
}

async function runBundler(
  projectRoot: string,
  qvacSdkPath: string,
  configPath: string | null,
  deferredModules: string[],
  hosts: string[],
  installMissingPrebuilds: boolean
): Promise<string> {
  const result = await bundleSdk({
    projectRoot,
    sdkPath: qvacSdkPath,
    ...(configPath ? { configPath } : {}),
    hosts,
    defer: deferredModules,
    quiet: true,
    installMissingPrebuilds,
    // runVerifier checks engines.bare right after, with progress output.
    checkEngines: false
  })
  if (result.installedPrebuilds.length > 0) {
    const names = result.installedPrebuilds.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')
    console.log(`📦 QVAC: Installed addon platform packages: ${names}`)
  }

  return result.entryPaths.worker
}

export {
  MOBILE_HOSTS,
  MOBILE_HOSTS_BY_PLATFORM,
  MOBILE_UNSUPPORTED_MODULES,
  buildMobileBundle,
  mobileHostsForPlatform
}
export type { MobileBundleOptions, MobilePlatform }

export default withMobileBundle
