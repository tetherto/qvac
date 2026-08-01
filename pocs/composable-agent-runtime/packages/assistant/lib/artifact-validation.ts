import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export interface PackageInstance {
  readonly name: string
  readonly version: string
  readonly packagePath: string
  readonly singleton: boolean
}

export interface ExecutionRealm {
  readonly name: string
  readonly roots: readonly string[]
  readonly packages?: readonly PackageInstance[]
}

export interface NativeAddonIdentity {
  readonly name: string
  readonly version: string
}

export interface ValidationIssue {
  readonly code: string
  readonly message: string
  readonly realm?: string
  readonly packageName?: string
}

export interface ArtifactValidationReport {
  readonly ok: boolean
  readonly errors: readonly ValidationIssue[]
  readonly realms: readonly ExecutionRealm[]
  readonly nativeAddons: readonly NativeAddonIdentity[]
}

export interface ValidateArtifactsOptions {
  readonly projectRoot: string
  readonly realms: readonly ExecutionRealm[]
  readonly singletonPackages: readonly string[]
  readonly sdkAddons: readonly NativeAddonIdentity[]
  readonly workers: readonly {
    readonly name: string
    readonly nativeAddons: readonly NativeAddonIdentity[]
  }[]
  readonly mergedAddons: readonly NativeAddonIdentity[]
  readonly stagedResources?: readonly string[]
  readonly targetHost?: 'android' | 'desktop'
}

interface PackageManifest {
  readonly name?: string
  readonly version?: string
  readonly addon?: boolean
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly exports?: unknown
}

export async function validateArtifacts(
  options: ValidateArtifactsOptions
): Promise<ArtifactValidationReport> {
  const singletonPackages = new Set(options.singletonPackages)
  const realms = await Promise.all(
    options.realms.map(async (realm) => ({
      ...realm,
      packages:
        realm.packages?.map((instance) => ({
          ...instance,
          singleton: instance.singleton || singletonPackages.has(instance.name)
        })) ??
        (await resolveRealmPackages(options.projectRoot, realm.roots, singletonPackages))
    }))
  )
  const errors: ValidationIssue[] = []
  validateRealmDuplicates(realms, errors)
  const expectedAddons = validateAddonUnion(options, errors)
  validateInstalledAddonVersions(realms, expectedAddons, errors)
  if (options.stagedResources) {
    const requiredAddons = await filterRequiredAddons(
      options.projectRoot,
      expectedAddons,
      options.targetHost
    )
    validateStagedResources(
      options.stagedResources,
      expectedAddons,
      requiredAddons,
      errors
    )
  }
  return {
    ok: errors.length === 0,
    errors,
    realms,
    nativeAddons: expectedAddons
  }
}

async function filterRequiredAddons(
  projectRoot: string,
  addons: readonly NativeAddonIdentity[],
  targetHost: 'android' | 'desktop' | undefined
) {
  if (targetHost !== 'android') return addons
  const required: NativeAddonIdentity[] = []
  for (const addon of addons) {
    const manifestPath = await resolvePackageManifest(addon.name, projectRoot)
    const manifest = await readManifest(manifestPath)
    if (
      manifest.version === addon.version &&
      hasUnsupportedAndroidExport(manifest.exports)
    ) {
      continue
    }
    required.push(addon)
  }
  return required
}

function hasUnsupportedAndroidExport(exportsValue: unknown) {
  if (typeof exportsValue !== 'object' || exportsValue === null || Array.isArray(exportsValue)) {
    return false
  }
  const rootExport = Reflect.get(exportsValue, '.')
  if (typeof rootExport !== 'object' || rootExport === null || Array.isArray(rootExport)) {
    return false
  }
  const android = Reflect.get(rootExport, 'android')
  return typeof android === 'string' && /(?:^|\/)unsupported\.[cm]?js$/.test(android)
}

function validateInstalledAddonVersions(
  realms: readonly ExecutionRealm[],
  addons: readonly NativeAddonIdentity[],
  errors: ValidationIssue[]
) {
  const installed = new Set(
    realms.flatMap((realm) =>
      (realm.packages ?? []).map((instance) => `${instance.name}@${instance.version}`)
    )
  )
  for (const addon of addons) {
    if (installed.has(addonKey(addon))) continue
    errors.push({
      code: 'NATIVE_ADDON_VERSION_NOT_INSTALLED',
      message: `No execution realm contains ${addonKey(addon)}`,
      packageName: addon.name
    })
  }
}

export function assertArtifactValidation(report: ArtifactValidationReport) {
  if (report.ok) return
  throw new Error(
    `Assistant artifact validation failed:\n${report.errors
      .map((issue) => `- [${issue.code}] ${issue.message}`)
      .join('\n')}`
  )
}

export async function listStagedResources(directory: string) {
  const resources: string[] = []
  await walk(directory, directory, resources)
  return resources.sort()
}

async function resolveRealmPackages(
  projectRoot: string,
  roots: readonly string[],
  singletonPackages: ReadonlySet<string>
) {
  const queue = roots.map((name) => ({ name, from: projectRoot }))
  const visited = new Set<string>()
  const packages: PackageInstance[] = []
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    const manifestPath = await resolvePackageManifest(current.name, current.from)
    const physicalManifest = await realpath(manifestPath)
    if (visited.has(physicalManifest)) continue
    visited.add(physicalManifest)
    const manifest = await readManifest(physicalManifest)
    if (!manifest.name || !manifest.version) {
      throw new Error(`Package manifest omitted name/version: ${physicalManifest}`)
    }
    const packagePath = path.dirname(physicalManifest)
    packages.push({
      name: manifest.name,
      version: manifest.version,
      packagePath,
      singleton: singletonPackages.has(manifest.name) || manifest.addon === true
    })
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies
    }
    for (const name of Object.keys(dependencies).sort()) {
      try {
        await resolvePackageManifest(name, packagePath)
        queue.push({ name, from: packagePath })
      } catch {
        if (manifest.optionalDependencies?.[name] === undefined) throw new Error(
          `Unable to resolve ${name} required by ${manifest.name}@${manifest.version}`
        )
      }
    }
  }
  return packages.sort(comparePackageInstances)
}

async function resolvePackageManifest(name: string, from: string) {
  let directory = path.resolve(from)
  while (true) {
    const candidate = path.join(directory, 'node_modules', ...name.split('/'), 'package.json')
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch {}
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(`Unable to resolve package ${name} from ${from}`)
}

async function readManifest(manifestPath: string): Promise<PackageManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Malformed package manifest: ${manifestPath}`)
  }
  return parsed as PackageManifest
}

function validateRealmDuplicates(
  realms: readonly ExecutionRealm[],
  errors: ValidationIssue[]
) {
  for (const realm of realms) {
    const versions = new Map<string, Set<string>>()
    for (const instance of realm.packages ?? []) {
      if (!instance.singleton) continue
      const current = versions.get(instance.name) ?? new Set<string>()
      current.add(instance.version)
      versions.set(instance.name, current)
    }
    for (const [name, found] of versions) {
      if (found.size < 2) continue
      errors.push({
        code: 'DUPLICATE_SINGLETON_VERSION',
        message: `${realm.name} contains ${name} at versions ${[...found].sort().join(', ')}`,
        realm: realm.name,
        packageName: name
      })
    }
  }
}

function validateAddonUnion(
  options: ValidateArtifactsOptions,
  errors: ValidationIssue[]
) {
  const declared = [
    ...options.sdkAddons,
    ...options.workers.flatMap((worker) => worker.nativeAddons)
  ]
  const versions = new Map<string, Set<string>>()
  for (const addon of declared) {
    const current = versions.get(addon.name) ?? new Set<string>()
    current.add(addon.version)
    versions.set(addon.name, current)
  }
  for (const [name, found] of versions) {
    if (found.size < 2) continue
    errors.push({
      code: 'CONFLICTING_NATIVE_ADDON_VERSION',
      message: `${name} is required at versions ${[...found].sort().join(', ')}`,
      packageName: name
    })
  }
  const expected = uniqueAddons(declared)
  const merged = uniqueAddons(options.mergedAddons)
  const expectedKeys = new Set(expected.map(addonKey))
  const mergedKeys = new Set(merged.map(addonKey))
  for (const addon of expected) {
    if (mergedKeys.has(addonKey(addon))) continue
    errors.push({
      code: 'MISSING_MERGED_ADDON',
      message: `Merged linker manifest omits ${addonKey(addon)}`,
      packageName: addon.name
    })
  }
  for (const addon of merged) {
    if (expectedKeys.has(addonKey(addon))) continue
    errors.push({
      code: 'UNDECLARED_MERGED_ADDON',
      message: `Merged linker manifest includes undeclared ${addonKey(addon)}`,
      packageName: addon.name
    })
  }
  return expected
}

function validateStagedResources(
  resources: readonly string[],
  expected: readonly NativeAddonIdentity[],
  required: readonly NativeAddonIdentity[],
  errors: ValidationIssue[]
) {
  const staged = new Set<string>()
  for (const resource of resources) {
    const identity = identifyNativeResource(resource, expected)
    if (!identity) continue
    staged.add(addonKey(identity))
  }
  const expectedKeys = new Set(expected.map(addonKey))
  for (const addon of required) {
    if (staged.has(addonKey(addon))) continue
    errors.push({
      code: 'MISSING_NATIVE_PREBUILD',
      message: `No staged native resource found for ${addonKey(addon)}`,
      packageName: addon.name
    })
  }
  for (const key of staged) {
    if (expectedKeys.has(key)) continue
    errors.push({
      code: 'UNDECLARED_STAGED_ADDON',
      message: `Staged native resource is not declared by a worker: ${key}`
    })
  }
}

function identifyNativeResource(
  resource: string,
  expected: readonly NativeAddonIdentity[]
) {
  const normalized = resource.replaceAll('\\', '/')
  for (const addon of expected) {
    const encoded = addon.name.startsWith('@')
      ? addon.name.slice(1).replace('/', '__')
      : addon.name
    if (
      containsResourceIdentity(normalized, encoded) &&
      (normalized.includes(addon.version) || !/\d+\.\d+\.\d+/.test(normalized))
    ) {
      return addon
    }
  }
  const encoded = normalized.match(
    /(?:^|\/)(?:lib)?([a-z0-9-]+__[a-z0-9-]+)(?:\.(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?))?\.(?:so|bare|node|framework)(?:\/|$)/i
  )
  const identity = encoded?.[1]
  if (identity) {
    const separator = identity.indexOf('__')
    const scope = identity.slice(0, separator)
    const name = identity.slice(separator + 2)
    return {
      name: `@${scope}/${name}`,
      version: encoded[2] ?? 'unknown'
    }
  }
  return null
}

function containsResourceIdentity(resource: string, encodedName: string) {
  const candidates = [encodedName, `lib${encodedName}`]
  return resource.split('/').some((segment) =>
    candidates.some(
      (candidate) => segment === candidate || segment.startsWith(`${candidate}.`)
    )
  )
}

async function walk(root: string, directory: string, resources: string[]) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await walk(root, absolute, resources)
    } else if (entry.isFile()) {
      resources.push(path.relative(root, absolute))
    }
  }
}

function uniqueAddons(addons: readonly NativeAddonIdentity[]) {
  return [...new Map(addons.map((addon) => [addonKey(addon), addon])).values()].sort(
    (left, right) => addonKey(left).localeCompare(addonKey(right))
  )
}

function addonKey(addon: NativeAddonIdentity) {
  return `${addon.name}@${addon.version}`
}

function comparePackageInstances(left: PackageInstance, right: PackageInstance) {
  return (
    left.name.localeCompare(right.name) ||
    left.version.localeCompare(right.version) ||
    left.packagePath.localeCompare(right.packagePath)
  )
}
