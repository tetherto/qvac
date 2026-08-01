import {
  createRunOncePlugin,
  withDangerousMod,
  withPlugins,
  withRunOnce,
  type ConfigPlugin,
  type ExportedConfigWithProps
} from '@expo/config-plugins'
import type { ExpoConfig } from '@expo/config-types'
import { buildHarnessReactNativeBundle } from '@qvac/harness/react-native-stow'
import sdkExpoPlugin from '@qvac/sdk/expo-plugin'
import { buildSyncReactNativeBundle } from '@qvac/sync/react-native-stow'
import Bundle from 'bare-bundle'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertArtifactValidation,
  validateArtifacts,
  type ExecutionRealm,
  type PackageInstance
} from './lib/artifact-validation.ts'

const ASSISTANT_STACK_MANIFEST_VERSION = 3
const PLUGIN_EXECUTION_ORDER = Object.freeze([
  'build-sync-react-native-stow',
  'build-harness-react-native-stow',
  'invoke-sdk-expo-plugin',
  'merge-assistant-stack-manifests'
] as const)
const SDK_PLUGIN_ID = '@qvac/sdk/expo-plugin'
const ASSISTANT_PLUGIN_ID = '@qvac/assistant/expo-plugin'
const ASSISTANT_BUILD_RUN_ONCE = '@qvac/assistant/expo-plugin/build-workers'
const ASSISTANT_MERGE_RUN_ONCE = '@qvac/assistant/expo-plugin/merge-manifests'
const REQUIRED_MOBILE_HOSTS = Object.freeze([
  'android-arm64',
  'ios-arm64',
  'ios-arm64-simulator',
  'ios-x64-simulator'
] as const)
const WORKER_ADAPTER_VERSION = 1
const LINKED_PREFIX = 'linked:'
const assistantPackage = readAssistantPackageMetadata()
const ASSISTANT_PLUGIN_VERSION = assistantPackage.version
const ASSISTANT_MANIFEST_PROVENANCE_VERSION = 1

interface WorkerDescriptor {
  readonly entryPath: string
  readonly harnessPath: string
  readonly metadataPath: string
  readonly contract: string
  readonly protocolVersion: number
  readonly hosts: readonly string[]
}

interface WorkerMetadata {
  readonly bundleId: string | null
  readonly contract: string
  readonly protocolVersion: number
  readonly hosts: readonly string[]
  readonly nativeAddons: readonly string[]
  readonly packages?: readonly PackageInstance[]
}

interface WorkerBuildResult {
  readonly descriptor: WorkerDescriptor
  readonly bundlePath: string
  readonly metadata: WorkerMetadata
}

interface BuildFunctions {
  readonly buildSync: () => Promise<WorkerBuildResult>
  readonly buildHarness: () => Promise<WorkerBuildResult>
}

interface AssistantAddon {
  readonly name: string
  readonly version: string
}

interface SdkAddonsManifest {
  readonly version: number
  readonly bundleId: string | null
  readonly addons: readonly string[]
  readonly assistantProvenance?: AssistantManifestProvenance
}

interface ComposeAssistantStackOptions extends BuildFunctions {
  readonly projectRoot: string
}

interface CreateAssistantExpoPluginOptions extends BuildFunctions {
  readonly sdkPlugin: ConfigPlugin
}

interface WorkerAddonInventory {
  readonly role: 'sync' | 'harness'
  readonly contract: string
  readonly protocolVersion: number
  readonly bundleId: string
  readonly hosts: readonly string[]
  readonly nativeAddons: readonly AssistantAddon[]
  readonly packages?: readonly PackageInstance[]
}

interface BuiltWorkerArtifacts {
  readonly sync: WorkerAddonInventory
  readonly harness: WorkerAddonInventory
}

interface AssistantStackManifest {
  readonly manifestVersion: number
  readonly pluginExecutionOrder: readonly string[]
  readonly requiredHosts: readonly string[]
  readonly packageVersions: {
    readonly assistant: string
    readonly sync: string
    readonly harness: string
    readonly sdk: string
  }
  readonly bundles: {
    readonly sync: string
    readonly harness: string
    readonly sdk: string | null
  }
  readonly sdkSource: {
    readonly manifestVersion: number
    readonly bundleId: string | null
    readonly addons: readonly AssistantAddon[]
  }
  readonly workers: {
    readonly sync: {
      readonly contract: string
      readonly protocolVersion: number
      readonly hosts: readonly string[]
      readonly nativeAddons: readonly AssistantAddon[]
    }
    readonly harness: {
      readonly contract: string
      readonly protocolVersion: number
      readonly hosts: readonly string[]
      readonly nativeAddons: readonly AssistantAddon[]
    }
  }
  readonly mergedAddons: readonly AssistantAddon[]
  readonly realms: readonly ExecutionRealm[]
  readonly singletonPackages: readonly string[]
}

interface AssistantManifestProvenance {
  readonly schemaVersion: number
  readonly sourcePlugin: string
  readonly sourcePluginVersion: string
  readonly sdkSourceAddons: readonly AssistantAddon[]
}

export async function composeAssistantStack(options: ComposeAssistantStackOptions) {
  const builtWorkers = await buildWorkerArtifacts(options.projectRoot, options)
  await mergeAssistantManifests(options.projectRoot, builtWorkers)
}

export function createAssistantExpoPlugin(
  options: Partial<CreateAssistantExpoPluginOptions> = {}
) {
  const buildFunctions: BuildFunctions = {
    buildSync: options.buildSync ?? buildSyncReactNativeBundle,
    buildHarness: options.buildHarness ?? buildHarnessReactNativeBundle
  }
  const sdkPlugin = options.sdkPlugin ?? (sdkExpoPlugin as ConfigPlugin)
  const buildCache = new Map<string, Promise<BuiltWorkerArtifacts>>()
  const runOncePlugin = createRunOncePlugin(
    withAssistantExpoPlugin,
    ASSISTANT_PLUGIN_ID,
    ASSISTANT_PLUGIN_VERSION
  )

  return runOncePlugin

  function withAssistantExpoPlugin(config: ExpoConfig) {
    assertNoDuplicatePluginRegistration(config.plugins, sdkPlugin, runOncePlugin, withAssistantExpoPlugin)
    return withPlugins(config, [
      withRunOnceMergePlugin,
      sdkPlugin,
      withRunOnceBuildPlugin
    ])
  }

  function withRunOnceMergePlugin(config: ExpoConfig) {
    return withRunOnce(config, {
      name: ASSISTANT_MERGE_RUN_ONCE,
      version: ASSISTANT_PLUGIN_VERSION,
      plugin(configValue) {
        configValue = withDangerousMod(configValue, [
          'android',
          async (context) => {
            await mergeAfterSdk(context, buildFunctions, buildCache)
            return context
          }
        ])
        configValue = withDangerousMod(configValue, [
          'ios',
          async (context) => {
            await mergeAfterSdk(context, buildFunctions, buildCache)
            return context
          }
        ])
        return configValue
      }
    })
  }

  function withRunOnceBuildPlugin(config: ExpoConfig) {
    return withRunOnce(config, {
      name: ASSISTANT_BUILD_RUN_ONCE,
      version: ASSISTANT_PLUGIN_VERSION,
      plugin(configValue) {
        configValue = withDangerousMod(configValue, [
          'android',
          async (context) => {
            await buildOnce(context, buildFunctions, buildCache)
            return context
          }
        ])
        configValue = withDangerousMod(configValue, [
          'ios',
          async (context) => {
            await buildOnce(context, buildFunctions, buildCache)
            return context
          }
        ])
        return configValue
      }
    })
  }
}

const withAssistantExpoPlugin = createAssistantExpoPlugin()

export default withAssistantExpoPlugin

async function buildOnce(
  context: ExportedConfigWithProps<unknown>,
  buildFunctions: BuildFunctions,
  buildCache: Map<string, Promise<BuiltWorkerArtifacts>>
) {
  const projectRoot = readProjectRoot(context)
  getOrCreateBuild(projectRoot, buildFunctions, buildCache)
  await buildCache.get(projectRoot)
}

async function mergeAfterSdk(
  context: ExportedConfigWithProps<unknown>,
  buildFunctions: BuildFunctions,
  buildCache: Map<string, Promise<BuiltWorkerArtifacts>>
) {
  const projectRoot = readProjectRoot(context)
  const builtWorkers = await getOrCreateBuild(projectRoot, buildFunctions, buildCache)
  await mergeAssistantManifests(projectRoot, builtWorkers, true)
}

function getOrCreateBuild(
  projectRoot: string,
  buildFunctions: BuildFunctions,
  buildCache: Map<string, Promise<BuiltWorkerArtifacts>>
) {
  const existing = buildCache.get(projectRoot)
  if (existing) return existing
  const created = buildWorkerArtifacts(projectRoot, buildFunctions).catch((error) => {
    buildCache.delete(projectRoot)
    throw error
  })
  buildCache.set(projectRoot, created)
  return created
}

function readProjectRoot(context: ExportedConfigWithProps<unknown>) {
  const projectRoot = context.modRequest.projectRoot
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new Error('Expo plugin modRequest.projectRoot was missing')
  }
  return projectRoot
}

function assertNoDuplicatePluginRegistration(
  plugins: readonly (unknown | [unknown, unknown])[] | undefined,
  sdkPlugin: ConfigPlugin,
  assistantRunOncePlugin: ConfigPlugin,
  assistantPlugin: ConfigPlugin
) {
  const entries = plugins ?? []
  const sdkRegistrations = entries.filter((entry) =>
    isMatchingPluginEntry(entry, SDK_PLUGIN_ID, sdkPlugin)
  )
  if (sdkRegistrations.length > 0) {
    throw new Error(
      'Duplicate SDK plugin registration detected. ' +
        'Use only @qvac/assistant/expo-plugin and remove @qvac/sdk/expo-plugin from app config.'
    )
  }

  const assistantRegistrations = entries.filter((entry) =>
    isMatchingAssistantPluginEntry(entry, assistantRunOncePlugin, assistantPlugin)
  )
  if (assistantRegistrations.length > 1) {
    throw new Error('Duplicate plugin registration detected for @qvac/assistant/expo-plugin.')
  }
}

function isMatchingAssistantPluginEntry(
  entry: unknown,
  assistantRunOncePlugin: ConfigPlugin,
  assistantPlugin: ConfigPlugin
) {
  if (isMatchingPluginEntry(entry, ASSISTANT_PLUGIN_ID, assistantRunOncePlugin)) return true
  if (typeof entry === 'function') return entry === assistantPlugin
  if (!Array.isArray(entry)) return false
  const [plugin] = entry
  return typeof plugin === 'function' && plugin === assistantPlugin
}

function isMatchingPluginEntry(entry: unknown, pluginId: string, pluginFunction: ConfigPlugin) {
  if (typeof entry === 'string') {
    return entry === pluginId || entry.endsWith(pluginId)
  }
  if (typeof entry === 'function') return entry === pluginFunction
  if (!Array.isArray(entry) || entry.length === 0) return false
  const [plugin] = entry
  if (typeof plugin === 'string') {
    return plugin === pluginId || plugin.endsWith(pluginId)
  }
  return typeof plugin === 'function' && plugin === pluginFunction
}

async function buildWorkerArtifacts(
  projectRoot: string,
  buildFunctions: BuildFunctions
): Promise<BuiltWorkerArtifacts> {
  const syncResult = await buildFunctions.buildSync()
  const harnessResult = await buildFunctions.buildHarness()
  await assertWorkerArtifacts('sync', syncResult)
  await assertWorkerArtifacts('harness', harnessResult)
  return {
    sync: await createWorkerInventory(projectRoot, 'sync', syncResult),
    harness: await createWorkerInventory(projectRoot, 'harness', harnessResult)
  }
}

async function assertWorkerArtifacts(role: 'sync' | 'harness', buildResult: WorkerBuildResult) {
  await requireFile(buildResult.descriptor.harnessPath, `${role} harness`)
  await requireFile(buildResult.descriptor.metadataPath, `${role} metadata`)
  await requireFile(buildResult.bundlePath, `${role} bundle`)
}

async function requireFile(filePath: string, label: string) {
  try {
    await access(filePath)
  } catch {
    throw new Error(`Missing worker artifact (${label}): ${filePath}`)
  }
}

async function createWorkerInventory(
  projectRoot: string,
  role: 'sync' | 'harness',
  buildResult: WorkerBuildResult
): Promise<WorkerAddonInventory> {
  const metadata = validateWorkerMetadata(role, buildResult.metadata)
  const nativeAddons = await normalizeNativeAddonList(projectRoot, metadata.nativeAddons)
  return {
    role,
    contract: metadata.contract,
    protocolVersion: metadata.protocolVersion,
    bundleId: metadata.bundleId,
    hosts: [...metadata.hosts].sort(),
    nativeAddons,
    packages: metadata.packages
  }
}

function validateWorkerMetadata(
  role: 'sync' | 'harness',
  metadata: WorkerMetadata
): {
  readonly bundleId: string
  readonly contract: string
  readonly protocolVersion: 1
  readonly hosts: readonly string[]
  readonly nativeAddons: readonly string[]
  readonly packages?: readonly PackageInstance[]
} {
  const expectedContract = role === 'sync' ? 'qvac.sync' : 'qvac.harness'
  const hasBundleId = typeof metadata.bundleId === 'string' && metadata.bundleId.length > 0
  const hasContract = metadata.contract === expectedContract
  const hasProtocol = metadata.protocolVersion === WORKER_ADAPTER_VERSION
  const hasNativeAddons =
    Array.isArray(metadata.nativeAddons) &&
    metadata.nativeAddons.every((entry) => typeof entry === 'string')
  const hasHosts =
    Array.isArray(metadata.hosts) &&
    metadata.hosts.every((entry) => typeof entry === 'string') &&
    REQUIRED_MOBILE_HOSTS.every((requiredHost) => metadata.hosts.includes(requiredHost))
  const hasPackages =
    metadata.packages === undefined ||
    (Array.isArray(metadata.packages) &&
      metadata.packages.every(
        (entry) =>
          typeof entry.name === 'string' &&
          typeof entry.version === 'string' &&
          typeof entry.packagePath === 'string' &&
          typeof entry.singleton === 'boolean'
      ))
  if (
    !hasBundleId ||
    !hasContract ||
    !hasProtocol ||
    !hasNativeAddons ||
    !hasHosts ||
    !hasPackages
  ) {
    throw new Error(`Malformed worker metadata for ${role}.`)
  }
  return {
    bundleId: metadata.bundleId,
    contract: metadata.contract,
    protocolVersion: WORKER_ADAPTER_VERSION,
    hosts: metadata.hosts,
    nativeAddons: metadata.nativeAddons,
    packages: metadata.packages
  }
}

async function mergeAssistantManifests(
  projectRoot: string,
  builtWorkers: BuiltWorkerArtifacts,
  pinLinkerRoot = false
) {
  const qvacDirectory = path.join(projectRoot, 'qvac')
  const sdkManifestPath = path.join(qvacDirectory, 'addons.manifest.json')
  const stackManifestPath = path.join(qvacDirectory, 'assistant-stack.manifest.json')
  const sdkManifest = await readSdkManifest(sdkManifestPath)
  const sdkSourceAddons = await resolveSdkSourceAddons(projectRoot, sdkManifest)
  const mergedAddons = mergeAddonInventories(sdkSourceAddons, builtWorkers)
  const assistantProvenance: AssistantManifestProvenance = {
    schemaVersion: ASSISTANT_MANIFEST_PROVENANCE_VERSION,
    sourcePlugin: ASSISTANT_PLUGIN_ID,
    sourcePluginVersion: ASSISTANT_PLUGIN_VERSION,
    sdkSourceAddons
  }
  await mkdir(qvacDirectory, { recursive: true })
  await writeFile(
    sdkManifestPath,
    `${JSON.stringify(
      {
        version: sdkManifest.version,
        bundleId: sdkManifest.bundleId,
        addons: mergedAddons.map((entry) => entry.name),
        assistantProvenance
      },
      null,
      2
    )}\n`
  )

  const packageVersions = await readPackageVersions(projectRoot)
  const sdkBundlePackages = await readSdkBundlePackages(
    path.join(qvacDirectory, 'worker.bundle.js')
  )
  const stackManifest: AssistantStackManifest = {
    manifestVersion: ASSISTANT_STACK_MANIFEST_VERSION,
    pluginExecutionOrder: [...PLUGIN_EXECUTION_ORDER],
    requiredHosts: [...REQUIRED_MOBILE_HOSTS],
    packageVersions,
    bundles: {
      sync: builtWorkers.sync.bundleId,
      harness: builtWorkers.harness.bundleId,
      sdk: sdkManifest.bundleId
    },
    sdkSource: {
      manifestVersion: sdkManifest.version,
      bundleId: sdkManifest.bundleId,
      addons: sdkSourceAddons
    },
    workers: {
      sync: {
        contract: builtWorkers.sync.contract,
        protocolVersion: builtWorkers.sync.protocolVersion,
        hosts: builtWorkers.sync.hosts,
        nativeAddons: builtWorkers.sync.nativeAddons
      },
      harness: {
        contract: builtWorkers.harness.contract,
        protocolVersion: builtWorkers.harness.protocolVersion,
        hosts: builtWorkers.harness.hosts,
        nativeAddons: builtWorkers.harness.nativeAddons
      }
    },
    mergedAddons,
    realms: [
      {
        name: 'host',
        roots: ['@qvac/assistant'],
        packages: [
          {
            name: '@qvac/assistant',
            version: packageVersions.assistant,
            packagePath: fileURLToPath(new URL('./package.json', import.meta.url)),
            singleton: false
          }
        ]
      },
      {
        name: 'sync-worker',
        roots: ['@qvac/sync'],
        packages: createRecordedRealmPackages(
          '@qvac/sync',
          packageVersions.sync,
          builtWorkers.sync.bundleId,
          builtWorkers.sync.packages,
          builtWorkers.sync.nativeAddons
        )
      },
      {
        name: 'harness-worker',
        roots: ['@qvac/harness'],
        packages: createRecordedRealmPackages(
          '@qvac/harness',
          packageVersions.harness,
          builtWorkers.harness.bundleId,
          builtWorkers.harness.packages,
          builtWorkers.harness.nativeAddons
        )
      },
      {
        name: 'sdk-worker',
        roots: ['@qvac/sdk'],
        packages:
          sdkBundlePackages ??
          [
            {
              name: '@qvac/sdk',
              version: packageVersions.sdk,
              packagePath: `sdk-bundle:${sdkManifest.bundleId ?? 'unknown'}/@qvac/sdk`,
              singleton: false
            },
            ...sdkSourceAddons.map((addon) => ({
              ...addon,
              packagePath: `sdk-bundle:${sdkManifest.bundleId ?? 'unknown'}/${addon.name}`,
              singleton: true
            }))
          ]
      }
    ],
    singletonPackages: [
      'react-native-bare-kit',
      ...mergedAddons.map((addon) => addon.name)
    ].sort()
  }
  const validation = await validateArtifacts({
    projectRoot,
    realms: stackManifest.realms,
    singletonPackages: stackManifest.singletonPackages,
    sdkAddons: stackManifest.sdkSource.addons,
    workers: [
      {
        name: 'sync',
        nativeAddons: stackManifest.workers.sync.nativeAddons
      },
      {
        name: 'harness',
        nativeAddons: stackManifest.workers.harness.nativeAddons
      }
    ],
    mergedAddons: stackManifest.mergedAddons
  })
  assertArtifactValidation(validation)
  await writeFile(stackManifestPath, `${JSON.stringify(stackManifest, null, 2)}\n`)
  await writeFile(
    path.join(qvacDirectory, 'assistant-stack.validation.json'),
    `${JSON.stringify(validation, null, 2)}\n`
  )
  if (pinLinkerRoot) await pinBareKitLinkerProjectRoot(projectRoot)
}

async function pinBareKitLinkerProjectRoot(projectRoot: string) {
  const require = createRequire(path.join(projectRoot, 'package.json'))
  let packageJsonPath: string
  try {
    packageJsonPath = require.resolve('react-native-bare-kit/package.json')
  } catch {
    return
  }
  const packageRoot = path.dirname(packageJsonPath)
  for (const relativePath of ['android/link.mjs', 'ios/link.mjs']) {
    const linkerPath = path.join(packageRoot, relativePath)
    const source = await readFileStrict(linkerPath, `BareKit linker ${relativePath}`)
    const pattern = /^const projectRoot = .+$/m
    if (!pattern.test(source)) {
      throw new Error(`BareKit linker project-root declaration was not found: ${linkerPath}`)
    }
    await writeFile(
      linkerPath,
      source.replace(pattern, `const projectRoot = ${JSON.stringify(projectRoot)}`)
    )
  }
}

function createRecordedRealmPackages(
  rootName: string,
  rootVersion: string,
  bundleId: string,
  bundledPackages: readonly PackageInstance[] | undefined,
  nativeAddons: readonly AssistantAddon[]
) {
  const packages = [
    ...(bundledPackages ?? []),
    {
      name: rootName,
      version: rootVersion,
      packagePath: `bundle:${bundleId}/${rootName}`,
      singleton: false
    }
  ]
  const recorded = new Set(packages.map((entry) => `${entry.name}@${entry.version}`))
  for (const addon of nativeAddons) {
    const key = `${addon.name}@${addon.version}`
    if (recorded.has(key)) continue
    packages.push({
      ...addon,
      packagePath: `bundle:${bundleId}/${addon.name}`,
      singleton: true
    })
    recorded.add(key)
  }
  return packages
}

async function readSdkBundlePackages(bundlePath: string) {
  try {
    await access(bundlePath)
  } catch {
    return null
  }
  const source = await readFile(bundlePath)
  const text = source.toString('utf8')
  const prefix = 'module.exports = '
  const bundle = text.startsWith(prefix)
    ? decodeExportedBundle(text, prefix, bundlePath)
    : decodeBundle(source, bundlePath)
  const files = Reflect.get(bundle as object, 'files')
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    throw new Error(`SDK bundle omitted file inventory: ${bundlePath}`)
  }
  const packages: PackageInstance[] = []
  for (const [packagePath, file] of Object.entries(files)) {
    if (!packagePath.endsWith('/package.json') || typeof file !== 'object' || file === null) {
      continue
    }
    const data = Reflect.get(file, '_data')
    if (!(data instanceof Uint8Array)) continue
    const parsed: unknown = JSON.parse(Buffer.from(data).toString('utf8'))
    if (!isObject(parsed) || typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
      continue
    }
    packages.push({
      name: parsed.name,
      version: parsed.version,
      packagePath,
      singleton: parsed.addon === true
    })
  }
  if (packages.length === 0) {
    throw new Error(`SDK bundle contained no package manifests: ${bundlePath}`)
  }
  return packages.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version) ||
      left.packagePath.localeCompare(right.packagePath)
  )
}

function decodeExportedBundle(source: string, prefix: string, bundlePath: string) {
  const literal = source.slice(prefix.length).trim().replace(/;$/, '')
  const encoded: unknown = JSON.parse(literal)
  if (typeof encoded !== 'string') {
    throw new Error(`SDK bundle wrapper did not export a string: ${bundlePath}`)
  }
  return Bundle.from(encoded)
}

function decodeBundle(data: Uint8Array, bundlePath: string) {
  const from = Reflect.get(Bundle, 'from')
  if (typeof from !== 'function') {
    throw new Error('bare-bundle did not expose Bundle.from')
  }
  const decoded: unknown = Reflect.apply(from, Bundle, [data])
  if (!(decoded instanceof Bundle)) {
    throw new Error(`Unable to decode SDK bundle: ${bundlePath}`)
  }
  return decoded
}

async function readSdkManifest(sdkManifestPath: string): Promise<SdkAddonsManifest> {
  let source = ''
  try {
    source = await readFile(sdkManifestPath, 'utf8')
  } catch {
    throw new Error(
      `Missing SDK addons manifest: ${sdkManifestPath}. ` +
        'Run @qvac/sdk/expo-plugin before assistant manifest merge.'
    )
  }
  const parsed = parseJson(source, sdkManifestPath, 'SDK addons manifest')
  if (!isSdkManifest(parsed)) {
    throw new Error(`Malformed SDK addons manifest: ${sdkManifestPath}`)
  }
  return parsed
}

function parseJson(source: string, filePath: string, label: string) {
  try {
    return JSON.parse(source) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Malformed ${label} JSON at ${filePath}: ${message}`)
  }
}

function isSdkManifest(value: unknown): value is SdkAddonsManifest {
  if (!isObject(value)) return false
  const version = value.version
  const bundleId = value.bundleId
  const addons = value.addons
  return (
    typeof version === 'number' &&
    Number.isFinite(version) &&
    (bundleId === null || typeof bundleId === 'string') &&
    Array.isArray(addons) &&
    addons.every((entry) => typeof entry === 'string')
  )
}

function isVersionedAddon(value: unknown): value is AssistantAddon {
  return (
    isObject(value) &&
    typeof value.name === 'string' &&
    typeof value.version === 'string'
  )
}

function isAssistantManifestProvenance(value: unknown): value is AssistantManifestProvenance {
  return (
    isObject(value) &&
    value.schemaVersion === ASSISTANT_MANIFEST_PROVENANCE_VERSION &&
    value.sourcePlugin === ASSISTANT_PLUGIN_ID &&
    typeof value.sourcePluginVersion === 'string' &&
    Array.isArray(value.sdkSourceAddons) &&
    value.sdkSourceAddons.every(isVersionedAddon)
  )
}

async function resolveSdkSourceAddons(
  projectRoot: string,
  sdkManifest: SdkAddonsManifest
) {
  if (isAssistantManifestProvenance(sdkManifest.assistantProvenance)) {
    return [...sdkManifest.assistantProvenance.sdkSourceAddons].sort(compareAddons)
  }
  return resolveAddonsByAncestor(projectRoot, sdkManifest.addons)
}

async function normalizeNativeAddonList(
  projectRoot: string,
  nativeAddons: readonly string[]
): Promise<readonly AssistantAddon[]> {
  const addonsByName = new Map<string, AssistantAddon>()
  for (const resource of nativeAddons) {
    const normalized = await normalizeNativeAddon(projectRoot, resource)
    const previous = addonsByName.get(normalized.name)
    if (!previous) {
      addonsByName.set(normalized.name, normalized)
      continue
    }
    if (previous.version !== normalized.version) {
      throw new Error(
        `Conflicting versions for native addon ${normalized.name}: ` +
          `${previous.version} vs ${normalized.version}`
      )
    }
  }
  return [...addonsByName.values()].sort(compareAddons)
}

async function normalizeNativeAddon(
  projectRoot: string,
  resource: string
): Promise<AssistantAddon> {
  const linkedAddon = parseLinkedAddon(resource)
  if (linkedAddon) {
    const versionExists = await packageVersionExistsInTree(
      projectRoot,
      linkedAddon.name,
      linkedAddon.version
    )
    if (!versionExists) {
      throw new Error(
        `Unable to resolve required package version for ${linkedAddon.name}@${linkedAddon.version} ` +
          `from package tree rooted at ${projectRoot}`
      )
    }
    return linkedAddon
  }

  const packageFromPath = await readAddonFromNodeModulesResource(projectRoot, resource)
  if (packageFromPath) return packageFromPath

  if (isPackageName(resource)) {
    const version = await resolvePackageVersion(projectRoot, resource)
    return { name: resource, version }
  }

  throw new Error(`Malformed native addon metadata resource: ${resource}`)
}

function parseLinkedAddon(resource: string): AssistantAddon | null {
  if (!resource.startsWith(LINKED_PREFIX)) return null
  const token = resource.slice(LINKED_PREFIX.length)
  const framework = token.match(/^(.+)\.(\d+\.\d+\.\d+(?:[-+][^/]+)?)\.framework(?:\/.*)?$/)
  if (framework) {
    return {
      name: decodeLinkedPackageName(framework[1] ?? ''),
      version: framework[2] ?? ''
    }
  }
  const sharedObject = token.match(/^lib(.+)\.(\d+\.\d+\.\d+(?:[-+][^/]+)?)\.so$/)
  if (sharedObject) {
    return {
      name: decodeLinkedPackageName(sharedObject[1] ?? ''),
      version: sharedObject[2] ?? ''
    }
  }
  throw new Error(`Malformed native addon metadata resource: ${resource}`)
}

function decodeLinkedPackageName(value: string) {
  if (value.includes('__')) {
    const [scope, pkg] = value.split('__', 2)
    if (scope && pkg) return `@${scope}/${pkg}`
  }
  return value
}

async function readAddonFromNodeModulesResource(
  projectRoot: string,
  resource: string
): Promise<AssistantAddon | null> {
  const segment = readPackageSegment(resource)
  if (!segment) return null
  const source = await readFileStrict(segment.packageJsonPath, 'native addon package metadata')
  const parsed = parseJson(source, segment.packageJsonPath, 'native addon package metadata')
  if (!isObject(parsed) || typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
    throw new Error(`Malformed native addon package metadata: ${segment.packageJsonPath}`)
  }
  const versionExists = await packageVersionExistsInTree(projectRoot, parsed.name, parsed.version)
  if (!versionExists) {
    throw new Error(
      `Unable to resolve required package version for ${parsed.name}@${parsed.version} ` +
        `from package tree rooted at ${projectRoot}`
    )
  }
  return {
    name: parsed.name,
    version: parsed.version
  }
}

function readPackageSegment(resource: string) {
  const normalized = resource.replaceAll('\\', '/')
  const marker = 'node_modules/'
  const markerIndex = normalized.lastIndexOf(marker)
  if (markerIndex === -1) return null
  const fromNodeModules = normalized.slice(markerIndex + marker.length)
  const segments = fromNodeModules.split('/').filter((entry) => entry.length > 0)
  if (segments.length === 0) return null
  const packageName =
    segments[0]?.startsWith('@') && segments[1]
      ? `${segments[0]}/${segments[1]}`
      : (segments[0] ?? null)
  if (packageName === null) return null
  const packageDirectory = path.resolve(
    normalized.slice(0, markerIndex + marker.length),
    ...packageName.split('/')
  )
  return {
    packageJsonPath: path.join(packageDirectory, 'package.json')
  }
}

function isPackageName(value: string) {
  if (value.startsWith('@')) return /^@[^/]+\/[^/]+$/.test(value)
  return !value.includes('/') && !value.includes('\\')
}

function mergeAddonInventories(
  sdkSourceAddons: readonly AssistantAddon[],
  builtWorkers: BuiltWorkerArtifacts
) {
  const addonsByName = new Map<string, AssistantAddon>()
  for (const addon of sdkSourceAddons) {
    addonsByName.set(addon.name, addon)
  }
  for (const addon of [...builtWorkers.sync.nativeAddons, ...builtWorkers.harness.nativeAddons]) {
    const previous = addonsByName.get(addon.name)
    if (!previous) {
      addonsByName.set(addon.name, addon)
      continue
    }
    if (previous.version !== addon.version) {
      throw new Error(
        `Conflicting versions for native addon ${addon.name}: ${previous.version} vs ${addon.version}`
      )
    }
  }
  return [...addonsByName.values()].sort(compareAddons)
}

async function resolveAddonsByAncestor(projectRoot: string, addonNames: readonly string[]) {
  const result: AssistantAddon[] = []
  for (const addonName of addonNames) {
    const version = await resolvePackageVersion(projectRoot, addonName)
    result.push({ name: addonName, version })
  }
  result.sort(compareAddons)
  return result
}

function compareAddons(left: AssistantAddon, right: AssistantAddon) {
  if (left.name !== right.name) return left.name.localeCompare(right.name)
  return left.version.localeCompare(right.version)
}

async function readPackageVersions(projectRoot: string) {
  const assistantPackageJsonPath = resolveAssistantPackageJsonPath()
  const assistantSource = await readFileStrict(assistantPackageJsonPath, 'assistant package metadata')
  const assistantParsed = parseJson(assistantSource, assistantPackageJsonPath, 'assistant package metadata')
  if (!isObject(assistantParsed) || typeof assistantParsed.version !== 'string') {
    throw new Error(`Malformed assistant package metadata: ${assistantPackageJsonPath}`)
  }
  return {
    assistant: assistantParsed.version,
    sync: await resolvePackageVersion(projectRoot, '@qvac/sync'),
    harness: await resolvePackageVersion(projectRoot, '@qvac/harness'),
    sdk: await resolvePackageVersion(projectRoot, '@qvac/sdk')
  }
}

async function resolvePackageVersion(projectRoot: string, packageName: string) {
  const packageJsonPath = await findPackageJsonInAncestors(projectRoot, packageName)
  const source = await readFileStrict(packageJsonPath, `package metadata for ${packageName}`)
  const parsed = parseJson(source, packageJsonPath, `package metadata for ${packageName}`)
  if (!isObject(parsed) || typeof parsed.version !== 'string') {
    throw new Error(`Malformed package metadata for ${packageName}: ${packageJsonPath}`)
  }
  return parsed.version
}

const packageVersionTreeCache = new Map<string, Promise<readonly string[]>>()

async function packageVersionExistsInTree(
  projectRoot: string,
  packageName: string,
  version: string
) {
  const cacheKey = `${projectRoot}::${packageName}`
  let versionsPromise = packageVersionTreeCache.get(cacheKey)
  if (!versionsPromise) {
    versionsPromise = collectPackageVersionsInTree(projectRoot, packageName)
    packageVersionTreeCache.set(cacheKey, versionsPromise)
  }
  const versions = await versionsPromise
  return versions.includes(version)
}

async function collectPackageVersionsInTree(projectRoot: string, packageName: string) {
  const discovered = new Set<string>()
  const visitedNodeModules = new Set<string>()
  let currentDirectory = path.resolve(projectRoot)
  const rootDirectory = path.parse(currentDirectory).root
  while (true) {
    const nodeModules = path.join(currentDirectory, 'node_modules')
    await traverseNodeModulesForPackage(nodeModules, packageName, discovered, visitedNodeModules)
    if (currentDirectory === rootDirectory) break
    currentDirectory = path.dirname(currentDirectory)
  }
  return [...discovered].sort()
}

async function traverseNodeModulesForPackage(
  nodeModulesPath: string,
  packageName: string,
  discoveredVersions: Set<string>,
  visitedNodeModules: Set<string>
) {
  const canonical = path.resolve(nodeModulesPath)
  if (visitedNodeModules.has(canonical)) return
  visitedNodeModules.add(canonical)
  try {
    await access(canonical)
  } catch {
    return
  }

  const packageJsonPath = path.join(canonical, ...packageName.split('/'), 'package.json')
  try {
    const source = await readFile(packageJsonPath, 'utf8')
    const parsed = parseJson(source, packageJsonPath, `package metadata for ${packageName}`)
    if (isObject(parsed) && typeof parsed.version === 'string') {
      discoveredVersions.add(parsed.version)
    }
  } catch {
    // package may not exist at this level, continue traversing nested trees
  }

  const entries = await readdir(canonical, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const packageDirectory = path.join(canonical, entry.name)
    if (entry.name.startsWith('@')) {
      const scopedEntries = await readdir(packageDirectory, { withFileTypes: true })
      for (const scopedEntry of scopedEntries) {
        if (!scopedEntry.isDirectory()) continue
        await traverseNodeModulesForPackage(
          path.join(packageDirectory, scopedEntry.name, 'node_modules'),
          packageName,
          discoveredVersions,
          visitedNodeModules
        )
      }
      continue
    }
    await traverseNodeModulesForPackage(
      path.join(packageDirectory, 'node_modules'),
      packageName,
      discoveredVersions,
      visitedNodeModules
    )
  }
}

async function findPackageJsonInAncestors(projectRoot: string, packageName: string) {
  let currentDirectory = path.resolve(projectRoot)
  const rootDirectory = path.parse(currentDirectory).root
  while (true) {
    const candidate = path.join(
      currentDirectory,
      'node_modules',
      ...packageName.split('/'),
      'package.json'
    )
    try {
      await access(candidate)
      return candidate
    } catch {
      if (currentDirectory === rootDirectory) break
      currentDirectory = path.dirname(currentDirectory)
    }
  }
  throw new Error(
    `Unable to resolve required package version for ${packageName} from ancestor node_modules of ${projectRoot}`
  )
}

async function readFileStrict(filePath: string, label: string) {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read ${label} at ${filePath}: ${message}`)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readAssistantPackageMetadata() {
  const require = createRequire(import.meta.url)
  const packageJson = require(resolveAssistantPackageJsonPath()) as { version?: string }
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('Assistant package version is required for expo plugin provenance.')
  }
  return packageJson as { version: string }
}

function resolveAssistantPackageJsonPath() {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  return path.join(
    path.basename(moduleDirectory) === 'dist'
      ? path.dirname(moduleDirectory)
      : moduleDirectory,
    'package.json'
  )
}
