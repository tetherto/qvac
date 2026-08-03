import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  assertArtifactValidation,
  validateArtifacts,
  type PackageInstance
} from '../artifact-validation.ts'
import {
  compareAddons,
  isObject,
  mergeAddonInventories,
  parseJson,
  readAssistantPackageVersion,
  readFileStrict,
  readPackageVersions,
  resolveAddonsByAncestor,
  resolveAssistantPackageJsonPath
} from './addon-inventory.ts'
import { pinBareKitLinkerProjectRoot } from './barekit-linker.ts'
import { readSdkBundlePackages } from './sdk-bundle-inventory.ts'
import {
  ASSISTANT_MANIFEST_PROVENANCE_VERSION,
  ASSISTANT_PLUGIN_ID,
  ASSISTANT_STACK_MANIFEST_VERSION,
  PLUGIN_EXECUTION_ORDER,
  REQUIRED_MOBILE_HOSTS,
  type AssistantAddon,
  type AssistantManifestProvenance,
  type AssistantStackManifest,
  type BuiltWorkerArtifacts,
  type SdkAddonsManifest
} from '../expo/types.ts'

const ASSISTANT_PLUGIN_VERSION = readAssistantPackageVersion()

export async function writeAssistantStackArtifacts(
  projectRoot: string,
  builtWorkers: BuiltWorkerArtifacts,
  pinLinkerRoot = false
) {
  const qvacDirectory = path.join(projectRoot, 'qvac')
  const sdkManifestPath = path.join(qvacDirectory, 'addons.manifest.json')
  const stackManifestPath = path.join(qvacDirectory, 'assistant-stack.manifest.json')
  const sdkManifest = await readSdkManifest(sdkManifestPath)
  const sdkSourceAddons = await resolveSdkSourceAddons(projectRoot, sdkManifest)
  const mergedAddons = mergeAddonInventories(
    sdkSourceAddons,
    builtWorkers.sync.nativeAddons,
    builtWorkers.harness.nativeAddons
  )
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
            packagePath: resolveAssistantPackageJsonPath(),
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

export async function readSdkManifest(sdkManifestPath: string): Promise<SdkAddonsManifest> {
  let source = ''
  try {
    source = await readFileStrict(sdkManifestPath, 'SDK addons manifest')
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

export async function resolveSdkSourceAddons(
  projectRoot: string,
  sdkManifest: SdkAddonsManifest
) {
  if (isAssistantManifestProvenance(sdkManifest.assistantProvenance)) {
    return [...sdkManifest.assistantProvenance.sdkSourceAddons].sort(compareAddons)
  }
  return resolveAddonsByAncestor(projectRoot, sdkManifest.addons)
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
  return isObject(value) && typeof value.name === 'string' && typeof value.version === 'string'
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
