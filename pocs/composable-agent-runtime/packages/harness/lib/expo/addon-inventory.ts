import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { NativeAddonIdentity } from './types.ts'

const linkedPrefix = 'linked:'
const packageVersionTreeCache = new Map<string, Promise<readonly string[]>>()

export async function normalizeNativeAddonList(
  projectRoot: string,
  resources: readonly string[]
): Promise<readonly NativeAddonIdentity[]> {
  const byName = new Map<string, NativeAddonIdentity>()
  for (const resource of resources) {
    const addon = await normalizeNativeAddon(projectRoot, resource)
    const previous = byName.get(addon.name)
    if (previous && previous.version !== addon.version) {
      throw new Error(
        `Conflicting versions for native addon ${addon.name}: ${previous.version} vs ${addon.version}`
      )
    }
    byName.set(addon.name, addon)
  }
  return [...byName.values()].sort(compareAddons)
}

async function normalizeNativeAddon(projectRoot: string, resource: string) {
  const linked = parseLinkedAddon(resource)
  if (linked) {
    await assertPackageVersionInTree(projectRoot, linked)
    return linked
  }
  const fromResource = await readAddonFromNodeModulesResource(projectRoot, resource)
  if (fromResource) return fromResource
  if (!isPackageName(resource)) {
    throw new Error(`Malformed native addon metadata resource: ${resource}`)
  }
  return { name: resource, version: await resolvePackageVersion(projectRoot, resource) }
}

export function parseLinkedAddon(resource: string): NativeAddonIdentity | null {
  if (!resource.startsWith(linkedPrefix)) return null
  const token = resource.slice(linkedPrefix.length)
  const framework = token.match(/^(.+)\.(\d+\.\d+\.\d+(?:[-+][^/]+)?)\.framework(?:\/.*)?$/)
  const sharedObject = token.match(/^lib(.+)\.(\d+\.\d+\.\d+(?:[-+][^/]+)?)\.so$/)
  const match = framework ?? sharedObject
  if (!match) throw new Error(`Malformed native addon metadata resource: ${resource}`)
  return { name: decodeLinkedPackageName(match[1] ?? ''), version: match[2] ?? '' }
}

export async function packageVersionExistsInTree(
  projectRoot: string,
  packageName: string,
  version: string
) {
  const cacheKey = `${projectRoot}::${packageName}`
  let versions = packageVersionTreeCache.get(cacheKey)
  if (!versions) {
    versions = collectPackageVersionsInTree(projectRoot, packageName)
    packageVersionTreeCache.set(cacheKey, versions)
  }
  return (await versions).includes(version)
}

async function readAddonFromNodeModulesResource(projectRoot: string, resource: string) {
  const packageJsonPath = readPackageJsonPath(resource)
  if (!packageJsonPath) return null
  const parsed = await readPackageManifest(packageJsonPath)
  await assertPackageVersionInTree(projectRoot, parsed)
  return parsed
}

function readPackageJsonPath(resource: string) {
  const normalized = resource.replaceAll('\\', '/')
  const marker = 'node_modules/'
  const markerIndex = normalized.lastIndexOf(marker)
  if (markerIndex === -1) return null
  const segments = normalized.slice(markerIndex + marker.length).split('/').filter(Boolean)
  const name =
    segments[0]?.startsWith('@') && segments[1] ? `${segments[0]}/${segments[1]}` : segments[0]
  if (!name) return null
  return path.join(normalized.slice(0, markerIndex + marker.length), ...name.split('/'), 'package.json')
}

async function assertPackageVersionInTree(projectRoot: string, addon: NativeAddonIdentity) {
  if (await packageVersionExistsInTree(projectRoot, addon.name, addon.version)) return
  throw new Error(
    `Unable to resolve required package version for ${addon.name}@${addon.version} ` +
      `from package tree rooted at ${projectRoot}`
  )
}

async function resolvePackageVersion(projectRoot: string, packageName: string) {
  const packageJsonPath = await findPackageJsonInAncestors(projectRoot, packageName)
  return (await readPackageManifest(packageJsonPath)).version
}

async function collectPackageVersionsInTree(projectRoot: string, packageName: string) {
  const versions = new Set<string>()
  const visited = new Set<string>()
  let directory = path.resolve(projectRoot)
  while (true) {
    await traverseNodeModules(path.join(directory, 'node_modules'), packageName, versions, visited)
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return [...versions].sort()
}

async function traverseNodeModules(
  nodeModules: string,
  packageName: string,
  versions: Set<string>,
  visited: Set<string>
): Promise<void> {
  const resolved = path.resolve(nodeModules)
  if (visited.has(resolved)) return
  visited.add(resolved)
  try {
    await access(resolved)
  } catch {
    return
  }
  try {
    versions.add((await readPackageManifest(path.join(resolved, ...packageName.split('/'), 'package.json'))).version)
  } catch {}
  for (const entry of await readdir(resolved, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = path.join(resolved, entry.name)
    if (entry.name.startsWith('@')) {
      for (const scoped of await readdir(directory, { withFileTypes: true })) {
        if (scoped.isDirectory()) {
          await traverseNodeModules(path.join(directory, scoped.name, 'node_modules'), packageName, versions, visited)
        }
      }
    } else {
      await traverseNodeModules(path.join(directory, 'node_modules'), packageName, versions, visited)
    }
  }
}

async function findPackageJsonInAncestors(projectRoot: string, packageName: string) {
  let directory = path.resolve(projectRoot)
  while (true) {
    const candidate = path.join(directory, 'node_modules', ...packageName.split('/'), 'package.json')
    try {
      await access(candidate)
      return candidate
    } catch {}
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(`Unable to resolve required package version for ${packageName} from ancestor node_modules of ${projectRoot}`)
}

async function readPackageManifest(packageJsonPath: string): Promise<NativeAddonIdentity> {
  const parsed: unknown = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  if (!isObject(parsed) || typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
    throw new Error(`Malformed native addon package metadata: ${packageJsonPath}`)
  }
  return { name: parsed.name, version: parsed.version }
}

function decodeLinkedPackageName(value: string) {
  const [scope, name] = value.split('__', 2)
  return scope && name ? `@${scope}/${name}` : value
}

function isPackageName(value: string) {
  return value.startsWith('@') ? /^@[^/]+\/[^/]+$/.test(value) : !value.includes('/') && !value.includes('\\')
}

function compareAddons(left: NativeAddonIdentity, right: NativeAddonIdentity) {
  return left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
