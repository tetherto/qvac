import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeNativeAddonList } from './addon-inventory.ts'
import {
  requiredMobileHosts,
  type ComposeSyncContributionOptions,
  type PackageIdentity,
  type SyncBuildResult,
  type SyncContribution
} from './types.ts'

export async function composeSyncContribution(
  projectRoot: string,
  buildResult: SyncBuildResult,
  options: ComposeSyncContributionOptions = {}
): Promise<SyncContribution> {
  await assertArtifacts(buildResult)
  const metadata = await readAndValidateSyncMetadata(buildResult.descriptor.metadataPath)
  const nativeAddons = await normalizeNativeAddonList(projectRoot, metadata.nativeAddons)
  const contribution: SyncContribution = {
    schemaVersion: 1,
    packageName: '@qvac/sync',
    packageVersion: options.packageVersion ?? '0.0.0-poc',
    contract: 'qvac.sync',
    protocolVersion: 1,
    bundleId: metadata.bundleId,
    hosts: [...metadata.hosts].sort(),
    nativeAddons,
    packages: [...metadata.packages],
    harnessPath: buildResult.descriptor.harnessPath,
    metadataPath: buildResult.descriptor.metadataPath,
    bundlePath: buildResult.bundlePath
  }
  const destination = path.join(projectRoot, 'qvac', 'contributions', 'sync.json')
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, `${JSON.stringify(contribution, null, 2)}\n`)
  return contribution
}

export async function readAndValidateSyncMetadata(metadataPath: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(metadataPath, 'utf8'))
  } catch (error) {
    throw new Error(`Malformed Sync metadata: unable to parse ${metadataPath}`, { cause: error })
  }
  return validateSyncMetadataShape(parsed)
}

export function validateSyncMetadataShape(metadata: unknown) {
  if (!isObject(metadata)) throw new Error('Malformed Sync metadata.')
  const bundleId = metadata.bundleId
  const contract = metadata.contract
  const protocolVersion = metadata.protocolVersion
  const hosts = metadata.hosts
  const nativeAddons = metadata.nativeAddons
  const packages = metadata.packages
  if (
    typeof bundleId !== 'string' ||
    bundleId.length === 0 ||
    contract !== 'qvac.sync' ||
    protocolVersion !== 1 ||
    !Array.isArray(hosts) ||
    !hosts.every((host) => typeof host === 'string') ||
    !requiredMobileHosts.every((host) => hosts.includes(host)) ||
    !Array.isArray(nativeAddons) ||
    !nativeAddons.every((addon) => typeof addon === 'string') ||
    !isValidPackages(packages)
  ) {
    throw new Error('Malformed Sync metadata.')
  }
  return {
    bundleId,
    hosts: hosts as readonly string[],
    nativeAddons: nativeAddons as readonly string[],
    packages: packages === undefined ? [] : (packages as readonly PackageIdentity[])
  }
}

export function validateSyncMetadata(buildResult: SyncBuildResult) {
  return validateSyncMetadataShape(buildResult.metadata)
}

function isValidPackages(packages: unknown): packages is readonly PackageIdentity[] | undefined {
  if (packages === undefined) return true
  return (
    Array.isArray(packages) &&
    packages.every(
      (entry) =>
        isObject(entry) &&
        typeof entry.name === 'string' &&
        typeof entry.version === 'string' &&
        typeof entry.packagePath === 'string' &&
        typeof entry.singleton === 'boolean'
    )
  )
}

async function assertArtifacts(buildResult: SyncBuildResult) {
  await Promise.all([
    requireFile(buildResult.descriptor.harnessPath, 'harness'),
    requireFile(buildResult.descriptor.metadataPath, 'metadata'),
    requireFile(buildResult.bundlePath, 'bundle')
  ])
}

async function requireFile(filePath: string, label: string) {
  try {
    await access(filePath)
  } catch {
    throw new Error(`Missing Sync artifact (${label}): ${filePath}`)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
