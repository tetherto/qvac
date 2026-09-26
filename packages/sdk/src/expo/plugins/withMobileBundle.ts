import configPlugins from '@expo/config-plugins'
import type { ExpoConfig } from 'expo/config'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { execPath } from 'process'
import { bundleSdk, verifyBundle, hasErrors, formatVerifyBundleResult } from '@/commands'
import { createCommandLogger } from '@/commands/command-logger'
import { installMissingHostPrebuilds } from '@/commands/host-prebuilds/index'
import { collectAddonsFromBundle } from '@/commands/verify/bundle-source'
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
 * -> `bare-posix` (no `android-arm64` prebuild). Mobile advisory uses
 * in-process `@qvac/model-fit` (`fitParams`), not this subprocess.
 */
const MOBILE_UNSUPPORTED_MODULES = ['bare-runtime/spawn', '@qvac/model-fit/process']

type MobilePlatform = 'android' | 'ios'

const MOBILE_HOSTS_BY_PLATFORM: Record<MobilePlatform, string[]> = {
  android: ['android-arm64'],
  ios: ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator']
}

/** Compiled resolver copied beside each patched linker as this filename. */
const PLATFORM_ADDON_RESOLVER = 'qvac-platform-addons.mjs'

/** Every mobile host, in platform order. The bundle covers all of them. */
const MOBILE_HOSTS = [...MOBILE_HOSTS_BY_PLATFORM.android, ...MOBILE_HOSTS_BY_PLATFORM.ios]

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
  const bundle = () =>
    runBundler(projectRoot, sdkPackage.dir, configPath, deferredModules, MOBILE_HOSTS)
  let linkerPaths = await bundle()
  const generatedBundle = path.join(projectRoot, 'qvac', 'worker.bundle.js')

  if (options.installMissingPrebuilds === true) {
    // Take the addons from the bundle graph, which records where each linked
    // addon really is; looking their names up in the project would miss the
    // SDK's addons under pnpm or bun's isolated layout.
    const { installed } = await installMissingHostPrebuilds({
      projectRoot,
      hosts: platformHosts,
      addons: await collectAddonsFromBundle({
        bundlePath: generatedBundle,
        projectRoot,
        hosts: platformHosts
      }),
      quiet: false,
      logger: createCommandLogger({})
    })
    if (installed.length > 0) {
      const names = installed.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')
      console.log(`📦 QVAC: Installed addon platform packages: ${names}`)
      // bare-pack resolved `#host-addon` to the addon's fallback module for
      // hosts whose platform package was missing.
      linkerPaths = await bundle()
    }
  }

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
  if (!configPath) {
    console.log(
      '⚠️ QVAC: no qvac.config.* found — Bare runtime will be auto-detected ' +
        'from node_modules (bare-runtime, then bare). Add qvac.config.json ' +
        'with `bareRuntimeVersion` to pin ABI checks deterministically.'
    )
  }

  const result = await verifyBundle({
    projectRoot,
    addonsSource: generatedBundle,
    hosts,
    ...(configPath ? { configPath } : {})
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
  hosts: string[]
): Promise<BareKitLinkerPaths> {
  const linkerPaths = patchBareKitLinkers(projectRoot, qvacSdkPath)

  await bundleSdk({
    projectRoot,
    sdkPath: qvacSdkPath,
    ...(configPath ? { configPath } : {}),
    hosts,
    defer: deferredModules,
    quiet: true
  })

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
  const resolver = compiledPlatformAddonResolver(qvacSdkPath)
  if (!fs.existsSync(patchesDir)) {
    console.log(`⚠️ QVAC: patches directory not found (${patchesDir}), skipping linker patch`)
    return { android: null, ios: null }
  }

  return {
    android: copyLinkerPatch(
      patchesDir,
      resolver,
      path.join(bareKitPath, 'android'),
      'android-link.mjs'
    ),
    ios: copyLinkerPatch(patchesDir, resolver, path.join(bareKitPath, 'ios'), 'ios-link.mjs')
  }
}

/**
 * Copies one linker patch and the split-addon resolver it imports, returning the
 * installed linker path. The resolver has to sit beside the linker: the patch is
 * installed into react-native-bare-kit and imports it relatively.
 */
function copyLinkerPatch(
  patchesDir: string,
  resolver: string,
  targetDir: string,
  patchName: string
): string | null {
  const patch = path.join(patchesDir, patchName)
  if (!fs.existsSync(patch) || !fs.existsSync(resolver)) {
    // Installing the patch without the resolver it imports would break linking
    // outright, so leave the stock linker in place instead.
    console.log(`⚠️ QVAC: linker patch incomplete (${patch}), leaving the stock linker`)
    return null
  }

  const target = path.join(targetDir, 'link.mjs')
  fs.copyFileSync(patch, target)
  fs.copyFileSync(resolver, path.join(targetDir, PLATFORM_ADDON_RESOLVER))
  console.log(`✅ QVAC: Patched ${path.basename(targetDir)}/link.mjs for manifest-aware linking`)
  return target
}

function compiledPlatformAddonResolver(qvacSdkPath: string): string {
  return path.join(
    qvacSdkPath,
    'dist',
    'src',
    'expo',
    'plugins',
    'patches',
    'qvac-platform-addons.js'
  )
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
