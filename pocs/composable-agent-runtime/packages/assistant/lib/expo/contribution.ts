import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  REQUIRED_MOBILE_HOSTS,
  WORKER_ADAPTER_VERSION,
  type BuiltWorkerArtifacts,
  type PackageContribution,
  type WorkerAddonInventory
} from './types.ts'
import { isObject, parseJson } from '../packaging/addon-inventory.ts'

export async function readPackageContributions(
  projectRoot: string,
  overrides: {
    readonly syncContribution?: PackageContribution
    readonly harnessContribution?: PackageContribution
  } = {}
): Promise<BuiltWorkerArtifacts> {
  const syncContribution =
    overrides.syncContribution ??
    (await readContributionFile(projectRoot, 'sync', 'qvac.sync', '@qvac/sync'))
  const harnessContribution =
    overrides.harnessContribution ??
    (await readContributionFile(projectRoot, 'harness', 'qvac.harness', '@qvac/harness'))
  return {
    sync: contributionToInventory('sync', syncContribution),
    harness: contributionToInventory('harness', harnessContribution)
  }
}

async function readContributionFile(
  projectRoot: string,
  role: 'sync' | 'harness',
  expectedContract: string,
  expectedPackageName: string
) {
  const contributionPath = path.join(projectRoot, 'qvac', 'contributions', `${role}.json`)
  let source = ''
  try {
    await access(contributionPath)
    source = await readFile(contributionPath, 'utf8')
  } catch {
    throw new Error(
      `Missing ${role} contribution: ${contributionPath}. ` +
        `Run @qvac/${role}/expo-plugin in contributor mode before assistant finalization.`
    )
  }
  const parsed = parseJson(source, contributionPath, `${role} contribution`)
  return validateContribution(parsed, role, expectedContract, expectedPackageName, contributionPath)
}

function validateContribution(
  value: unknown,
  role: 'sync' | 'harness',
  expectedContract: string,
  expectedPackageName: string,
  contributionPath: string
): PackageContribution {
  if (!isObject(value)) {
    throw new Error(`Malformed ${role} contribution: ${contributionPath}`)
  }
  const schemaVersion = value.schemaVersion
  const packageName = value.packageName
  const packageVersion = value.packageVersion
  const contract = value.contract
  const protocolVersion = value.protocolVersion
  const bundleId = value.bundleId
  const hosts = value.hosts
  const nativeAddons = value.nativeAddons
  const packages = value.packages
  const harnessPath = value.harnessPath
  const metadataPath = value.metadataPath
  const bundlePath = value.bundlePath

  const hasHosts =
    Array.isArray(hosts) &&
    hosts.every((entry) => typeof entry === 'string') &&
    REQUIRED_MOBILE_HOSTS.every((requiredHost) => hosts.includes(requiredHost))
  const hasAddons =
    Array.isArray(nativeAddons) &&
    nativeAddons.every(
      (entry) =>
        isObject(entry) && typeof entry.name === 'string' && typeof entry.version === 'string'
    )
  const hasPackages =
    Array.isArray(packages) &&
    packages.every(
      (entry) =>
        isObject(entry) &&
        typeof entry.name === 'string' &&
        typeof entry.version === 'string' &&
        typeof entry.packagePath === 'string' &&
        typeof entry.singleton === 'boolean'
    )

  if (
    schemaVersion !== 1 ||
    packageName !== expectedPackageName ||
    typeof packageVersion !== 'string' ||
    packageVersion.length === 0 ||
    contract !== expectedContract ||
    protocolVersion !== WORKER_ADAPTER_VERSION ||
    typeof bundleId !== 'string' ||
    bundleId.length === 0 ||
    !hasHosts ||
    !hasAddons ||
    !hasPackages ||
    typeof harnessPath !== 'string' ||
    harnessPath.length === 0 ||
    typeof metadataPath !== 'string' ||
    metadataPath.length === 0 ||
    typeof bundlePath !== 'string' ||
    bundlePath.length === 0
  ) {
    if (
      typeof protocolVersion === 'number' &&
      protocolVersion !== WORKER_ADAPTER_VERSION
    ) {
      throw new Error(
        `Protocol mismatch in ${role} contribution: expected ${WORKER_ADAPTER_VERSION}, got ${protocolVersion}`
      )
    }
    if (Array.isArray(hosts) && !hasHosts) {
      throw new Error(
        `Host mismatch in ${role} contribution: required mobile hosts are missing at ${contributionPath}`
      )
    }
    throw new Error(`Malformed ${role} contribution: ${contributionPath}`)
  }

  return {
    schemaVersion: 1,
    packageName: expectedPackageName,
    packageVersion,
    contract: expectedContract,
    protocolVersion: WORKER_ADAPTER_VERSION,
    bundleId,
    hosts: [...hosts].sort(),
    nativeAddons: nativeAddons as PackageContribution['nativeAddons'],
    packages: packages as PackageContribution['packages'],
    harnessPath,
    metadataPath,
    bundlePath
  }
}

function contributionToInventory(
  role: 'sync' | 'harness',
  contribution: PackageContribution
): WorkerAddonInventory {
  return {
    role,
    contract: contribution.contract,
    protocolVersion: contribution.protocolVersion,
    bundleId: contribution.bundleId,
    hosts: [...contribution.hosts].sort(),
    nativeAddons: [...contribution.nativeAddons],
    packages: [...contribution.packages]
  }
}
