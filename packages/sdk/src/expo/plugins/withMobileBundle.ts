import configPlugins from '@expo/config-plugins'
import type { ExpoConfig } from 'expo/config'
import * as fs from 'fs'
import * as path from 'path'
import { bundleSdk, verifyBundle, hasErrors, formatVerifyBundleResult } from '@/commands'
import { createCommandLogger } from '@/commands/command-logger'
import { linkAddons, resolveBareKitDir } from '@/commands/bundle/link'
import { installMissingHostPrebuilds } from '@/commands/host-prebuilds/index'
import { collectAddonsFromBundle } from '@/commands/verify/bundle-source'
import { CONFIG_CANDIDATES } from '@/client/config-loader/resolve-config.node'
import { resolveSDKPackageDir } from '@/expo/plugins/resolve-sdk-package-dir'
import { getProjectRootFromMod } from '@/expo/plugins/get-project-root'
import { BundleVerificationFailedError } from '@/utils/errors-client'

const { withDangerousMod } = configPlugins

/** Modules to defer from mobile bundles (not available at bundle time) */
const DEFERRED_MODULES = ['expo-file-system', 'react-native-bare-kit']

/**
 * Desktop-only spawn path, deferred so bare-pack does not walk `bare-process`
 * -> `bare-posix` (no `android-arm64` prebuild). Mobile runs the engine fitter
 * in process instead, so it never reaches this.
 */
const MOBILE_UNSUPPORTED_MODULES = ['bare-runtime/spawn']

type MobilePlatform = 'android' | 'ios'

const MOBILE_HOSTS_BY_PLATFORM: Record<MobilePlatform, string[]> = {
  android: ['android-arm64'],
  ios: ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator']
}

/** Every mobile host, in platform order. The bundle covers all of them. */
const MOBILE_HOSTS = [...MOBILE_HOSTS_BY_PLATFORM.android, ...MOBILE_HOSTS_BY_PLATFORM.ios]

/** The generated harness and its bundle, served as `@qvac/sdk/worker.mobile`. */
const WORKER_MOBILE_FILES = ['index.mjs', 'index.d.ts', 'index.bundle.mjs']

type BareKitLinkerPaths = {
  android: string | null
  ios: string | null
}

type MobileBundleOptions = {
  /**
   * Install the addon platform packages the bundle needs for the current
   * build target with the app's package manager, pinned in package.json.
   * Off by default: `expo prebuild` then fails and names each package to add.
   */
  installMissingPrebuilds?: boolean
}

/**
 * Expo plugin: bundle, verify, copy the worker into the SDK, then link the
 * native addons for the platform being built. Uses `qvac.config.*` if present.
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
  const logger = createCommandLogger({})

  const configPath = findConfigFile(projectRoot)
  if (configPath) {
    console.log(`🕚 QVAC: Found ${path.basename(configPath)}, generating tree-shaken bundle...`)
  } else {
    console.log('🕚 QVAC: No config found, generating default bundle (all plugins)...')
  }

  const deferredModules = [
    ...DEFERRED_MODULES,
    ...MOBILE_UNSUPPORTED_MODULES,
    `${sdkPackage.name}/worker.mobile`
  ]
  // The bundle is one shared artifact both platforms import, so it is built
  // for every mobile host: a dual-platform `expo prebuild` runs this mod twice
  // and the second run would otherwise overwrite the first platform's bundle
  // with one that resolved the other platform's conditions.
  const bundle = () =>
    bundleSdk({
      projectRoot,
      sdkPath: sdkPackage.dir,
      ...(configPath ? { configPath } : {}),
      target: 'react-native',
      hosts: MOBILE_HOSTS,
      defer: deferredModules,
      quiet: true,
      // runVerifier checks engines.bare right after, with progress output.
      checkEngines: false,
      link: false
    })
  let result = await bundle()

  if (options.installMissingPrebuilds === true) {
    const { installed } = await installMissingHostPrebuilds({
      projectRoot,
      hosts: platformHosts,
      addons: await collectAddonsFromBundle({
        bundlePath: result.bundlePath,
        projectRoot,
        hosts: platformHosts
      }),
      quiet: false,
      logger
    })
    if (installed.length > 0) {
      const names = installed.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')
      console.log(`📦 QVAC: Installed addon platform packages: ${names}`)
      // The bundle resolved `#host-addon` to the addon's fallback module for
      // hosts whose platform package was missing.
      result = await bundle()
    }
  }

  await runVerifier(projectRoot, result.bundlePath, platformHosts)

  copyWorker(path.dirname(result.harnessPath), path.join(sdkPackage.dir, 'dist', 'worker-mobile'))

  disableBareKitLinkers(projectRoot)
  const linked = await linkAddons({
    projectRoot,
    entryPath: result.entryPath,
    hosts: platformHosts,
    logger
  })
  console.log(`🔗 QVAC: Linked ${linked.length} native addon files for ${platformHosts.join(', ')}`)

  console.log('🫡 QVAC: Mobile bundle generated and verified')
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

async function runVerifier(projectRoot: string, bundlePath: string, hosts: string[]) {
  const result = await verifyBundle({
    projectRoot,
    addonsSource: bundlePath,
    hosts,
    onProgress: (message) => console.log(`🕚 QVAC: ${message}`)
  })

  if (hasErrors(result)) {
    throw new BundleVerificationFailedError(bundlePath, new Error(formatVerifyBundleResult(result)))
  }
}

function copyWorker(workerDir: string, outDir: string) {
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  for (const file of WORKER_MOBILE_FILES) {
    fs.copyFileSync(path.join(workerDir, file), path.join(outDir, file))
  }
}

/**
 * Empties react-native-bare-kit's own linkers, which its Gradle build and
 * `pod install` run, so they keep the addons `linkAddons` wrote.
 */
function disableBareKitLinkers(projectRoot: string): BareKitLinkerPaths {
  const bareKitDir = resolveBareKitDir(projectRoot)
  if (bareKitDir === null) return { android: null, ios: null }

  const empty = (platform: MobilePlatform) => {
    const linker = path.join(bareKitDir, platform, 'link.mjs')
    if (!fs.existsSync(linker)) return null
    fs.writeFileSync(linker, '')
    return linker
  }

  return { android: empty('android'), ios: empty('ios') }
}

export {
  MOBILE_HOSTS,
  MOBILE_HOSTS_BY_PLATFORM,
  MOBILE_UNSUPPORTED_MODULES,
  buildMobileBundle,
  disableBareKitLinkers,
  mobileHostsForPlatform
}
export type { BareKitLinkerPaths, MobileBundleOptions, MobilePlatform }

export default withMobileBundle
