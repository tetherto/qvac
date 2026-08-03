import { existsSync } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { requiredMobileHosts, type SyncContribution } from './types.ts'

interface ValidationReport {
  readonly ok: boolean
  readonly errors: readonly string[]
}

const linkerTargets = [
  { relativePath: 'android/link.mjs', patchName: 'android-link.mjs' },
  { relativePath: 'ios/link.mjs', patchName: 'ios-link.mjs' }
] as const

export async function finalizeSyncStandalone(projectRoot: string, contribution: SyncContribution) {
  const validation = validateStandaloneContribution(contribution)
  const qvacDirectory = path.join(projectRoot, 'qvac')
  await mkdir(qvacDirectory, { recursive: true })
  await writeFile(
    path.join(qvacDirectory, 'sync-stack.validation.json'),
    `${JSON.stringify(validation, null, 2)}\n`
  )
  if (!validation.ok) {
    throw new Error(`Sync standalone validation failed:\n${validation.errors.map((error) => `- ${error}`).join('\n')}`)
  }
  await writeFile(
    path.join(qvacDirectory, 'addons.manifest.json'),
    `${JSON.stringify(
      {
        version: 1,
        bundleId: contribution.bundleId,
        addons: contribution.nativeAddons.map((addon) => addon.name)
      },
      null,
      2
    )}\n`
  )
  await installBareKitLinkerAdaptation(projectRoot)
}

export function validateStandaloneContribution(contribution: SyncContribution): ValidationReport {
  const errors: string[] = []
  if (contribution.schemaVersion !== 1) errors.push('Contribution schema version must be 1')
  if (contribution.packageName !== '@qvac/sync') errors.push('Contribution package name must be @qvac/sync')
  if (contribution.contract !== 'qvac.sync') errors.push('Contribution contract must be qvac.sync')
  if (contribution.protocolVersion !== 1) errors.push('Contribution protocol version must be 1')
  if (!contribution.bundleId) errors.push('Contribution bundle ID is required')
  if (!contribution.harnessPath || !contribution.metadataPath || !contribution.bundlePath) {
    errors.push('Contribution artifact paths are required')
  }
  for (const host of requiredMobileHosts) {
    if (!contribution.hosts.includes(host)) {
      errors.push(`Contribution is missing required host ${host}`)
    }
  }

  const addonVersions = new Map<string, string>()
  for (const addon of contribution.nativeAddons) {
    const previous = addonVersions.get(addon.name)
    if (previous && previous !== addon.version) {
      errors.push(`Conflicting versions for native addon ${addon.name}: ${previous} vs ${addon.version}`)
    }
    addonVersions.set(addon.name, addon.version)
  }

  const singletonVersions = new Map<string, Set<string>>()
  const packageKeys = new Set<string>()
  for (const entry of contribution.packages) {
    packageKeys.add(`${entry.name}@${entry.version}`)
    if (!entry.singleton) continue
    const versions = singletonVersions.get(entry.name) ?? new Set<string>()
    versions.add(entry.version)
    singletonVersions.set(entry.name, versions)
  }
  for (const [name, versions] of singletonVersions) {
    if (versions.size < 2) continue
    errors.push(
      `Conflicting singleton package versions for ${name}: ${[...versions].sort().join(', ')}`
    )
  }

  if (contribution.nativeAddons.length > 0 && contribution.packages.length === 0) {
    errors.push('Contribution packages are required when native addons are declared')
  }
  for (const addon of contribution.nativeAddons) {
    const key = `${addon.name}@${addon.version}`
    if (packageKeys.has(key)) continue
    errors.push(`Native addon ${key} is missing from contribution packages`)
  }

  return { ok: errors.length === 0, errors }
}

export async function installBareKitLinkerAdaptation(projectRoot: string) {
  const packageRoot = findBareKitPackageRoot(projectRoot)
  if (!packageRoot) {
    throw new Error(
      'Standalone Sync Expo plugin requires react-native-bare-kit to prepare native linking'
    )
  }
  const patchesDirectory = resolvePatchesDirectory()
  for (const target of linkerTargets) {
    const linkerPath = path.join(packageRoot, target.relativePath)
    const patchPath = path.join(patchesDirectory, target.patchName)
    await assertReadable(linkerPath, `BareKit linker ${target.relativePath}`)
    const adaptation = await readFileStrict(patchPath, `BareKit linker adaptation ${target.patchName}`)
    const declaration = /^const projectRoot = .+$/m
    if (!declaration.test(adaptation)) {
      throw new Error(
        `BareKit linker adaptation is missing project-root declaration: ${patchPath}`
      )
    }
    await writeFile(
      linkerPath,
      adaptation.replace(declaration, `const projectRoot = ${JSON.stringify(projectRoot)}`)
    )
  }
}

function findBareKitPackageRoot(projectRoot: string) {
  let directory = path.resolve(projectRoot)
  let parent = path.dirname(directory)
  for (; directory !== parent; directory = parent, parent = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', 'react-native-bare-kit')
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
  }
  return null
}

function resolvePatchesDirectory() {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  if (path.basename(moduleDirectory) === 'dist') {
    return path.join(path.dirname(moduleDirectory), 'lib', 'expo', 'patches')
  }
  return path.join(moduleDirectory, 'patches')
}

async function assertReadable(filePath: string, label: string) {
  try {
    await access(filePath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read ${label} at ${filePath}: ${message}`)
  }
}

async function readFileStrict(filePath: string, label: string) {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read ${label} at ${filePath}: ${message}`)
  }
}
