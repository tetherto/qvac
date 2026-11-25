import configPlugins from '@expo/config-plugins'
import type { ExpoConfig } from 'expo/config'
import * as fs from 'fs'
import * as path from 'path'
import { bundleSdk } from '@/commands'
import { NATIVE_MODULES } from '@/commands/bundle/link'
import { discardStaged, replaceAll, scratchFolderFor } from '@/commands/bundle/scratch'
import {
  CONFIG_CANDIDATES,
  resolveConfigForProject
} from '@/client/config-loader/resolve-config.node'
import { resolveSDKPackageDir } from '@/expo/plugins/resolve-sdk-package-dir'
import { getProjectRootFromMod } from '@/expo/plugins/get-project-root'
import {
  EXPO_BARE_KIT_ENTRY,
  EXPO_BARE_KIT_ENTRY_SOURCE,
  EXPO_BARE_KIT_WORKER,
  MOBILE_HOSTS,
  MOBILE_HOSTS_BY_PLATFORM,
  mobileDeferredModules,
  type MobilePlatform
} from '@/expo/plugins/mobile-worker'

const { withDangerousMod } = configPlugins

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

/**
 * What adds Bare Kit and the worker's native addons to the app: the SDK
 * itself, or expo-bare-kit, which then also packs the worker that
 * `@qvac/sdk/worker.mobile` re-exports.
 */
type MobileLinker = 'sdk' | 'expo-bare-kit'

async function buildMobileBundle<T extends configPlugins.ExportedConfigWithProps<unknown>>(
  config: T,
  options: MobileBundleOptions,
  linker: MobileLinker = 'sdk'
) {
  const projectRoot = getProjectRootFromMod(config)
  const sdkPackage = resolveSDKPackageDir(projectRoot)
  const platformHosts = mobileHostsForPlatform(config.modRequest.platform)

  const configPath = findConfigFile(projectRoot)
  if (linker === 'expo-bare-kit') {
    assertNoSdkBareKit(projectRoot, config.modRequest.platform)
    await assertDecoderSupported(projectRoot, configPath)
  }
  if (configPath) {
    console.log(`🕚 QVAC: Found ${path.basename(configPath)}, generating tree-shaken bundle...`)
  } else {
    console.log('🕚 QVAC: No config found, generating default bundle (all plugins)...')
  }

  const deferredModules = mobileDeferredModules(sdkPackage.name)
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
    link: linker === 'sdk' ? platformHosts : false
  })
  if (result.installedPrebuilds.length > 0) {
    const names = result.installedPrebuilds.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')
    console.log(`📦 QVAC: Installed addon platform packages: ${names}`)
  }

  const workerMobileDir = path.join(sdkPackage.dir, 'dist', 'worker-mobile')
  if (linker === 'expo-bare-kit') {
    fs.writeFileSync(path.join(projectRoot, EXPO_BARE_KIT_ENTRY), EXPO_BARE_KIT_ENTRY_SOURCE)
    await replaceWorker(workerMobileDir, (dir) => {
      for (const file of ['index.js', 'index.d.ts']) {
        fs.writeFileSync(
          path.join(dir, file),
          `export { default } from '${EXPO_BARE_KIT_WORKER}'\n`
        )
      }
    })
    console.log('🫡 QVAC: Mobile worker generated and verified; expo-bare-kit links and packs it')
    return config
  }

  console.log(
    `🔗 QVAC: Linked ${result.linked.length} native addon files for ${platformHosts.join(', ')}`
  )
  await replaceWorker(workerMobileDir, (dir) => {
    for (const file of WORKER_MOBILE_FILES) {
      fs.copyFileSync(path.join(result.outputDir, file), path.join(dir, file))
    }
  })
  console.log('🫡 QVAC: Mobile bundle generated, verified and linked')
  return config
}

/**
 * Fails when the native project still holds the Bare Kit module the SDK adds
 * itself, which a prebuild without `--clean` keeps alongside expo-bare-kit's.
 */
function assertNoSdkBareKit(projectRoot: string, platform: string) {
  const { dir } = NATIVE_MODULES[mobilePlatform(platform)]
  if (!fs.existsSync(path.join(projectRoot, dir))) return
  throw new Error(
    `QVAC: ${dir} holds the Bare Kit the SDK added before expo-bare-kit was installed, and an ` +
      'app can hold only one. Run `npx expo prebuild --clean` to remove it.'
  )
}

/** Fails when `qvac.config` leaves the audio decoder out, which expo-bare-kit's workers cannot. */
async function assertDecoderSupported(projectRoot: string, configPath: string | null) {
  if (configPath === null) return
  const { config } = await resolveConfigForProject(projectRoot, configPath)
  if (config.includeAudioDecoder !== false) return
  throw new Error(
    `QVAC: includeAudioDecoder: false in ${path.basename(configPath)} is not supported when ` +
      'expo-bare-kit adds Bare Kit, which packs the decoder with the worker. Remove the setting.'
  )
}

function mobilePlatform(platform: string): MobilePlatform {
  if (platform !== 'android' && platform !== 'ios') {
    throw new Error(
      `QVAC: withMobileBundle only supports android and ios builds, got "${platform}"`
    )
  }
  return platform
}

function mobileHostsForPlatform(platform: string) {
  return MOBILE_HOSTS_BY_PLATFORM[mobilePlatform(platform)]
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

/** Replaces `outDir` with the files `write` puts in a folder, keeping the previous ones until it is done. */
async function replaceWorker(outDir: string, write: (dir: string) => void) {
  const scratch = await scratchFolderFor(outDir)
  const staged = [{ dir: outDir, next: scratch }]
  try {
    fs.mkdirSync(scratch, { recursive: true })
    write(scratch)
    await replaceAll(staged)
  } finally {
    await discardStaged(staged)
  }
}

export { MOBILE_HOSTS, MOBILE_HOSTS_BY_PLATFORM, buildMobileBundle, mobileHostsForPlatform }
export type { MobileBundleOptions, MobileLinker, MobilePlatform }

export default withMobileBundle
