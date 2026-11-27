import * as fs from 'fs'
import { resolveWorkerImports, type WorkerImports } from '@/commands/bundle/index'
import { resolveSDKPackageDir } from '@/expo/plugins/resolve-sdk-package-dir'

type MobilePlatform = 'android' | 'ios'

const MOBILE_HOSTS_BY_PLATFORM: Record<MobilePlatform, string[]> = {
  android: ['android-arm64'],
  ios: ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator']
}

/** Every mobile host, in platform order. The bundle covers all of them. */
const MOBILE_HOSTS = [...MOBILE_HOSTS_BY_PLATFORM.android, ...MOBILE_HOSTS_BY_PLATFORM.ios]

/** The worker entry `bundleSdk` writes, relative to the project. */
const MOBILE_WORKER_ENTRY = 'qvac/worker.entry.mjs'

/**
 * The entry expo-bare-kit packs, relative to the project. bare-stow loads it
 * with `require()`, which cannot wait for a top-level `await` in the worker's
 * ES modules, so it loads `MOBILE_WORKER_ENTRY` with `import()`.
 */
const EXPO_BARE_KIT_ENTRY = 'qvac/worker.entry.cjs'

const EXPO_BARE_KIT_ENTRY_SOURCE = `module.exports = async function start(ipc, ready) {
  const { default: start } = await import('./${MOBILE_WORKER_ENTRY.split('/').pop()}')
  return start(ipc, ready)
}
`

/** The module expo-bare-kit serves the worker it packs from `EXPO_BARE_KIT_ENTRY` as. */
const EXPO_BARE_KIT_WORKER = `expo-bare-kit/workers/${EXPO_BARE_KIT_ENTRY.replace(/\.cjs$/, '')}`

/** Modules the worker never loads, which the app provides or which are not available at bundle time. */
function mobileDeferredModules(sdkName: string): string[] {
  return ['expo-file-system', 'react-native-bare-kit', `${sdkName}/worker.mobile`]
}

interface QvacWorkerOptions {
  hosts: string[]
  imports: WorkerImports['imports']
  defer: string[]
}

/**
 * The bare-stow options the SDK worker is stowed with on phones. expo-bare-kit
 * links the addons of every worker together, so an app's own workers must be
 * listed with the same `imports` and `defer`.
 */
function qvacWorkerOptions(projectRoot: string = process.cwd()): QvacWorkerOptions {
  const sdk = resolveSDKPackageDir(projectRoot)
  const sdkPath = fs.realpathSync(sdk.dir)
  return {
    hosts: MOBILE_HOSTS,
    imports: resolveWorkerImports(projectRoot, sdkPath, sdk.name).imports,
    defer: mobileDeferredModules(sdk.name)
  }
}

export {
  EXPO_BARE_KIT_ENTRY,
  EXPO_BARE_KIT_ENTRY_SOURCE,
  EXPO_BARE_KIT_WORKER,
  MOBILE_HOSTS,
  MOBILE_HOSTS_BY_PLATFORM,
  MOBILE_WORKER_ENTRY,
  mobileDeferredModules,
  qvacWorkerOptions
}
export type { MobilePlatform, QvacWorkerOptions }
