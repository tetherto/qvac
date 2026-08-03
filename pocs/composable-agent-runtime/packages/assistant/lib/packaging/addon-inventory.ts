import { access, readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AssistantAddon } from '../expo/types.ts'

const LINKED_PREFIX = 'linked:'
const packageVersionTreeCache = new Map<string, Promise<readonly string[]>>()

export async function normalizeNativeAddonList(
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

export async function normalizeNativeAddon(
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

export function parseLinkedAddon(resource: string): AssistantAddon | null {
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

export function decodeLinkedPackageName(value: string) {
  if (value.includes('__')) {
    const [scope, pkg] = value.split('__', 2)
    if (scope && pkg) return `@${scope}/${pkg}`
  }
  return value
}

export function mergeAddonInventories(
  sdkSourceAddons: readonly AssistantAddon[],
  syncAddons: readonly AssistantAddon[],
  harnessAddons: readonly AssistantAddon[]
) {
  const addonsByName = new Map<string, AssistantAddon>()
  for (const addon of sdkSourceAddons) {
    addonsByName.set(addon.name, addon)
  }
  for (const addon of [...syncAddons, ...harnessAddons]) {
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

export async function resolveAddonsByAncestor(
  projectRoot: string,
  addonNames: readonly string[]
) {
  const result: AssistantAddon[] = []
  for (const addonName of addonNames) {
    const version = await resolvePackageVersion(projectRoot, addonName)
    result.push({ name: addonName, version })
  }
  result.sort(compareAddons)
  return result
}

export function compareAddons(left: AssistantAddon, right: AssistantAddon) {
  if (left.name !== right.name) return left.name.localeCompare(right.name)
  return left.version.localeCompare(right.version)
}

export async function resolvePackageVersion(projectRoot: string, packageName: string) {
  const packageJsonPath = await findPackageJsonInAncestors(projectRoot, packageName)
  const source = await readFileStrict(packageJsonPath, `package metadata for ${packageName}`)
  const parsed = parseJson(source, packageJsonPath, `package metadata for ${packageName}`)
  if (!isObject(parsed) || typeof parsed.version !== 'string') {
    throw new Error(`Malformed package metadata for ${packageName}: ${packageJsonPath}`)
  }
  return parsed.version
}

export async function readPackageVersions(projectRoot: string) {
  const assistantPackageJsonPath = resolveAssistantPackageJsonPath()
  const assistantSource = await readFileStrict(assistantPackageJsonPath, 'assistant package metadata')
  const assistantParsed = parseJson(
    assistantSource,
    assistantPackageJsonPath,
    'assistant package metadata'
  )
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

export function readAssistantPackageVersion() {
  const require = createRequire(import.meta.url)
  const packageJson = require(resolveAssistantPackageJsonPath()) as { version?: string }
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('Assistant package version is required for expo plugin provenance.')
  }
  return packageJson.version
}

export function resolveAssistantPackageJsonPath() {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const packageRoot =
    path.basename(moduleDirectory) === 'dist'
      ? path.dirname(moduleDirectory)
      : path.resolve(moduleDirectory, '../..')
  return path.join(packageRoot, 'package.json')
}

export async function packageVersionExistsInTree(
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

export async function readFileStrict(filePath: string, label: string) {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read ${label} at ${filePath}: ${message}`)
  }
}

export function parseJson(source: string, filePath: string, label: string) {
  try {
    return JSON.parse(source) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Malformed ${label} JSON at ${filePath}: ${message}`)
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
