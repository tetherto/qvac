import configPlugins from '@expo/config-plugins'
import type { ExpoConfig } from 'expo/config'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { execPath } from 'process'
import { bundleSdk, verifyBundle, hasErrors, formatVerifyBundleResult } from '@/commands'
import { CONFIG_CANDIDATES } from '@/client/config-loader/resolve-config.node'
import { resolveSDKPackageDir } from '@/expo/plugins/resolve-sdk-package-dir'
import { getProjectRootFromMod } from '@/expo/plugins/get-project-root'
import { findInAncestorNodeModules } from '@/expo/plugins/find-in-ancestor-node-modules'
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

type BareKitLinkerPaths = {
  android: string | null
  ios: string | null
}

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
 * Expo plugin: bundle, verify, then copy the mobile worker bundle.
 *
 * Flow: bundleSdk -> verifyBundle -> copy to `<sdkPackageDir>/dist/worker.mobile.bundle.js`.
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
  const linkerPaths = await runBundler(
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

  if (config.modRequest.platform === 'ios' && linkerPaths.ios !== null) {
    await runIOSAddonLinker(linkerPaths.ios)
  }

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
): Promise<BareKitLinkerPaths> {
  const linkerPaths = patchBareKitLinkers(projectRoot, qvacSdkPath)

  const { installedPrebuilds } = await bundleSdk({
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
  if (installedPrebuilds.length > 0) {
    const names = installedPrebuilds.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')
    console.log(`📦 QVAC: Installed addon platform packages: ${names}`)
  }

  return linkerPaths
}

/** Runs the patched iOS linker after bundleSdk has written the current addons manifest. */
async function runIOSAddonLinker(linkerPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(execPath, [linkerPath], {
      stdio: ['ignore', 'inherit', 'pipe']
    })
    let stderr = ''

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      const details = stderr.trim()
      reject(
        new Error(
          `QVAC: iOS native addon linker exited with code ${code ?? 1}${details ? `: ${details}` : ''}`
        )
      )
    })

    proc.on('error', reject)
  })

  console.log('✅ QVAC: Refreshed iOS native addons from the generated manifest')
}

/**
 * Patches react-native-bare-kit linkers to use the addons manifest and returns
 * the paths for each platform that was successfully patched.
 */
function patchBareKitLinkers(projectRoot: string, qvacSdkPath: string): BareKitLinkerPaths {
  const bareKitPath = findInAncestorNodeModules(projectRoot, 'react-native-bare-kit')
  if (bareKitPath === null) {
    console.warn(
      '⚠️ QVAC: react-native-bare-kit not found in any ancestor node_modules, ' +
        'skipping linker patch. The bundle will link all native addons ' +
        'rather than only those required by your bundle.'
    )
    return { android: null, ios: null }
  }

  const patchesDir = path.join(qvacSdkPath, 'src', 'expo', 'plugins', 'patches')
  if (!fs.existsSync(patchesDir)) {
    console.log(`⚠️ QVAC: patches directory not found (${patchesDir}), skipping linker patch`)
    return { android: null, ios: null }
  }

  return {
    android: copyLinkerPatch(patchesDir, path.join(bareKitPath, 'android'), 'android-link.mjs'),
    ios: copyLinkerPatch(patchesDir, path.join(bareKitPath, 'ios'), 'ios-link.mjs')
  }
}

/** Copies one linker patch, returning the installed linker path. */
function copyLinkerPatch(patchesDir: string, targetDir: string, patchName: string): string | null {
  const patch = path.join(patchesDir, patchName)
  if (!fs.existsSync(patch)) {
    console.log(`⚠️ QVAC: linker patch not found (${patch}), leaving the stock linker`)
    return null
  }

  const target = path.join(targetDir, 'link.mjs')
  fs.copyFileSync(patch, target)
  console.log(`✅ QVAC: Patched ${path.basename(targetDir)}/link.mjs for manifest-aware linking`)
  return target
}

export {
  MOBILE_HOSTS,
  MOBILE_HOSTS_BY_PLATFORM,
  MOBILE_UNSUPPORTED_MODULES,
  buildMobileBundle,
  mobileHostsForPlatform,
  patchBareKitLinkers,
  runIOSAddonLinker
}
export type { BareKitLinkerPaths, MobileBundleOptions, MobilePlatform }

export default withMobileBundle
