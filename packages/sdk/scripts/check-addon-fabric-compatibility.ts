import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FABRIC_PACKAGE = '@qvac/fabric'
const QVAC_SCOPE = '@qvac/'

type PackageDependencies = Record<string, string>

type PackageManifest = {
  addon?: boolean
  dependencies?: PackageDependencies
  name?: string
  optionalDependencies?: PackageDependencies
  peerDependencies?: PackageDependencies
  version?: string
}

type InstalledPackage = {
  dir: string
  manifest: PackageManifest
}

export type FabricConsumer = {
  addonName: string
  addonVersion: string
  fabricPackageDir: string | null
  fabricSpec: string
  fabricVersion: string | null
  packageDir: string
}

export type FabricCompatibilityReport = {
  consumers: FabricConsumer[]
  legacyAddons: Array<{ name: string; packageDir: string; version: string }>
  unresolvedConsumers: FabricConsumer[]
  versions: string[]
}

function readManifest(packageDir: string): PackageManifest | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    return value as PackageManifest
  } catch {
    return null
  }
}

function packagePath(nodeModulesDir: string, packageName: string): string {
  return join(nodeModulesDir, ...packageName.split('/'))
}

function fabricSpec(manifest: PackageManifest): string | undefined {
  for (const dependencies of [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies
  ]) {
    const spec = dependencies?.[FABRIC_PACKAGE]
    if (typeof spec === 'string') return spec
  }
  return undefined
}

function collectQvacPackages(rootNodeModules: string): InstalledPackage[] {
  const packages: InstalledPackage[] = []
  const visited = new Set<string>()
  const pending = [join(rootNodeModules, '@qvac')]

  while (pending.length > 0) {
    const scopeDir = pending.pop()!
    if (!existsSync(scopeDir)) continue

    let realScopeDir: string
    try {
      realScopeDir = realpathSync(scopeDir)
    } catch {
      continue
    }
    if (visited.has(realScopeDir)) continue
    visited.add(realScopeDir)

    for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue

      const dir = join(scopeDir, entry.name)
      const manifest = readManifest(dir)
      if (manifest?.name?.startsWith(QVAC_SCOPE)) {
        packages.push({ dir, manifest })
        pending.push(join(dir, 'node_modules', '@qvac'))
      }
    }
  }

  return packages
}

function resolveInstalledPackage(fromDir: string, packageName: string): string | null {
  let dir = resolve(fromDir)

  while (true) {
    const candidate = packagePath(join(dir, 'node_modules'), packageName)
    if (readManifest(candidate) !== null) return candidate

    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function dependencyVersion(packageDir: string | null): string | null {
  if (!packageDir) return null
  return readManifest(packageDir)?.version ?? null
}

export function inspectFabricCompatibility(rootDir: string): FabricCompatibilityReport {
  const installed = collectQvacPackages(join(resolve(rootDir), 'node_modules'))
  const addonPackages = installed.filter(
    ({ manifest }) => manifest.addon === true && manifest.name !== FABRIC_PACKAGE
  )

  const consumers: FabricConsumer[] = []
  const legacyAddons: FabricCompatibilityReport['legacyAddons'] = []

  for (const { dir, manifest } of addonPackages) {
    const name = manifest.name ?? '(unnamed addon)'
    const version = manifest.version ?? '(unknown)'
    const spec = fabricSpec(manifest)
    if (spec === undefined) {
      legacyAddons.push({ name, packageDir: dir, version })
      continue
    }

    const fabricPackageDir = resolveInstalledPackage(dir, FABRIC_PACKAGE)
    consumers.push({
      addonName: name,
      addonVersion: version,
      fabricPackageDir,
      fabricSpec: spec,
      fabricVersion: dependencyVersion(fabricPackageDir),
      packageDir: dir
    })
  }

  return {
    consumers,
    legacyAddons,
    unresolvedConsumers: consumers.filter((consumer) => consumer.fabricVersion === null),
    versions: [
      ...new Set(
        consumers.flatMap((consumer) => (consumer.fabricVersion ? [consumer.fabricVersion] : []))
      )
    ].sort()
  }
}

export function formatFabricCompatibilityReport(report: FabricCompatibilityReport): string {
  const lines = [
    `Fabric compatibility consumers: ${report.consumers.length}`,
    `Resolved Fabric versions: ${report.versions.length > 0 ? report.versions.join(', ') : '(none)'}`
  ]

  for (const consumer of report.consumers) {
    lines.push(
      `  - ${consumer.addonName}@${consumer.addonVersion}: ` +
        `@qvac/fabric ${consumer.fabricVersion ?? '(unresolved)'} ` +
        `(declared ${consumer.fabricSpec})`
    )
  }

  if (report.legacyAddons.length > 0) {
    lines.push(
      `Legacy addon metadata not checked yet (${report.legacyAddons.length}): ` +
        report.legacyAddons.map(({ name, version }) => `${name}@${version}`).join(', ')
    )
  }

  return lines.join('\n')
}

export function assertFabricCompatibility(
  report: FabricCompatibilityReport,
  options: { requireCompleteMetadata?: boolean } = {}
): void {
  const problems: string[] = []

  if (report.unresolvedConsumers.length > 0) {
    problems.push(
      'could not resolve @qvac/fabric for: ' +
        report.unresolvedConsumers
          .map(({ addonName, addonVersion }) => `${addonName}@${addonVersion}`)
          .join(', ')
    )
  }

  if (report.versions.length > 1) {
    problems.push(`mixed @qvac/fabric versions detected: ${report.versions.join(', ')}`)
  }

  if (options.requireCompleteMetadata && report.legacyAddons.length > 0) {
    problems.push(
      'addon metadata is incomplete; migrate these packages to declare @qvac/fabric: ' +
        report.legacyAddons.map(({ name, version }) => `${name}@${version}`).join(', ')
    )
  }

  if (problems.length > 0) {
    throw new Error(`${problems.join('; ')}\n\n${formatFabricCompatibilityReport(report)}`)
  }
}

function parseArgs(args: string[]): { requireCompleteMetadata: boolean; rootDir: string } {
  const rootIndex = args.indexOf('--root')
  const rootDir = rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : process.cwd()
  return {
    requireCompleteMetadata: args.includes('--require-complete-metadata'),
    rootDir
  }
}

function isEntryPoint(): boolean {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  const report = inspectFabricCompatibility(options.rootDir)
  console.log(formatFabricCompatibilityReport(report))

  if (report.consumers.length === 0) {
    console.log(
      'No @qvac/fabric-consuming addons were found; the check remains advisory while addon migration is in progress.'
    )
  }

  try {
    assertFabricCompatibility(report, options)
    console.log('Fabric compatibility preflight passed.')
  } catch (error) {
    console.error(
      `Fabric compatibility preflight failed: ${error instanceof Error ? error.message : error}`
    )
    process.exitCode = 1
  }
}

if (isEntryPoint()) main()
