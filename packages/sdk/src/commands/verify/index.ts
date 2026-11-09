import { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  createCollectDiagnostics,
  formatAddonId,
  type AddonSourceKind,
  type InvalidPackageJsonRecord,
  type NativeAddon
} from '@/commands/verify/addon-source'
import { collectAddonsFromBundle, InvalidBundleSourceError } from '@/commands/verify/bundle-source'
import {
  collectAddonsFromNodeModules,
  InvalidNodeModulesSourceError
} from '@/commands/verify/node-modules-source'
import { checkPrebuilds, type MissingPrebuildIssue } from '@/commands/verify/prebuilds'
import { resolvePearRuntime, resolveSidecarRuntime } from '@/commands/verify/sidecar-runtime'
import {
  checkAbi,
  type AbiIssue,
  type BareRuntimeResolution,
  type EnginesPackage
} from '@/commands/verify/abi'
import {
  BARE_KIT_PLATFORMS,
  bareKitPlatformOf,
  resolveBareKitRuntime,
  type BareKitPlatform,
  type FetchText,
  type ProgressFn
} from '@/commands/verify/bare-kit-runtime'
import {
  buildEnginesAdvice,
  formatEnginesAdvice,
  type EnginesAdvice,
  type FetchPackageMetadata
} from '@/commands/verify/engines-advice'
import type { PackageRecord } from '@/commands/verify/addon-source'

export interface VerifyBundleOptions {
  projectRoot: string
  addonsSource: string
  hosts: string[]
  /**
   * The Bare that desktop hosts run: the project's bare-sidecar (the default);
   * the bare-sidecar that pear-runtime resolves, for a `pear-runtime` bundle;
   * or bare-kit-kotlin as pinned by bare-stow, for a `bare-kit` bundle on the JVM.
   */
  desktopRuntime?: 'bare-sidecar' | 'pear-runtime' | 'bare-kit-kotlin'
  /**
   * Allow GitHub and npm registry requests: GitHub for a Bare Kit binding or
   * bare-kit release missing from the built-in tables, the registry only after
   * a mismatch is found, to suggest an override. Defaults to true.
   */
  network?: boolean
  /** Called before any step that waits on the network. */
  onProgress?: ProgressFn
  /** Test seams for the bare-stow whose Bare Kit pins are read, and the network lookups. */
  bareStowDir?: string
  fetchText?: FetchText
  fetchPackageMetadata?: FetchPackageMetadata
}

/** The Bare a platform runs, and the checked hosts on that platform. */
export interface PlatformRuntime {
  platform: BareKitPlatform | 'desktop'
  hosts: string[]
  resolution: BareRuntimeResolution
}

export interface InvalidSourceIssue {
  code: 'invalid-source'
  level: 'error'
  message: string
  addonsSource: string
}

export interface InvalidPackageJsonIssue {
  code: 'invalid-package-json'
  level: 'warning'
  message: string
  packageJsonPath: string
  expectedName?: string
  reason: string
}

export interface EmptyBundleResolutionsIssue {
  code: 'empty-bundle-resolutions'
  level: 'warning'
  message: string
  bundlePath: string
}

export type VerifyBundleIssue =
  | MissingPrebuildIssue
  | AbiIssue
  | InvalidSourceIssue
  | InvalidPackageJsonIssue
  | EmptyBundleResolutionsIssue

export interface VerifyBundleResult {
  addonsSource: string
  resolvedAddonsSource: string
  sourceKind: AddonSourceKind | null
  hosts: string[]
  /**
   * Bare runtime of each platform among the hosts, which ABI and engines.bare
   * are checked against: Bare Kit's on phones, and on desktop the one
   * `desktopRuntime` names.
   */
  runtimes: PlatformRuntime[]
  addons: NativeAddon[]
  issues: VerifyBundleIssue[]
  /** How to fix packages that fail a phone platform's engines.bare check, one entry per platform. */
  advice: EnginesAdvice[]
}

export async function verifyBundle(options: VerifyBundleOptions): Promise<VerifyBundleResult> {
  const { projectRoot, addonsSource, hosts } = options
  const resolvedAddonsSource = path.isAbsolute(addonsSource)
    ? addonsSource
    : path.resolve(projectRoot, addonsSource)

  if (hosts.length === 0) {
    return {
      addonsSource,
      resolvedAddonsSource,
      sourceKind: null,
      hosts,
      runtimes: [],
      addons: [],
      advice: [],
      issues: [
        {
          code: 'invalid-source',
          level: 'error',
          addonsSource,
          message: 'At least one host is required.'
        }
      ]
    }
  }

  const sourceKind = await detectSourceKind(resolvedAddonsSource)
  if (sourceKind === null) {
    return {
      addonsSource,
      resolvedAddonsSource,
      sourceKind: null,
      hosts,
      runtimes: [],
      addons: [],
      advice: [],
      issues: [
        {
          code: 'invalid-source',
          level: 'error',
          addonsSource,
          message:
            `--addons-source ${addonsSource} is not a readable file or directory ` +
            `(resolved to ${resolvedAddonsSource}).`
        }
      ]
    }
  }

  const diagnostics = createCollectDiagnostics()
  if (sourceKind === 'node-modules') {
    options.onProgress?.(`Scanning ${resolvedAddonsSource} for native addons and engines.bare...`)
  }
  let addons: NativeAddon[]
  try {
    addons =
      sourceKind === 'bare-pack-bundle'
        ? await collectAddonsFromBundle({
            bundlePath: resolvedAddonsSource,
            projectRoot,
            hosts,
            diagnostics
          })
        : await collectAddonsFromNodeModules({
            nodeModulesRoot: resolvedAddonsSource,
            diagnostics
          })
  } catch (error) {
    if (
      error instanceof InvalidBundleSourceError ||
      error instanceof InvalidNodeModulesSourceError
    ) {
      return {
        addonsSource,
        resolvedAddonsSource,
        sourceKind,
        hosts,
        runtimes: [],
        addons: [],
        advice: [],
        issues: [
          {
            code: 'invalid-source',
            level: 'error',
            addonsSource,
            message: error.message
          }
        ]
      }
    }
    throw error
  }

  const issues: VerifyBundleIssue[] = []
  issues.push(...buildInvalidPackageJsonIssues(diagnostics.invalidPackageJsons))
  if (sourceKind === 'bare-pack-bundle' && diagnostics.emptyResolutions) {
    issues.push({
      code: 'empty-bundle-resolutions',
      level: 'warning',
      bundlePath: resolvedAddonsSource,
      message:
        `Bundle at ${resolvedAddonsSource} has no resolutions in its bare-pack header ` +
        '(0 packages discoverable). The verifier cannot inspect any addons in this bundle; ' +
        '`Native addon verification passed` would be vacuous. Regenerate the bundle via ' +
        '`qvac bundle sdk` and re-run, or check for a corrupted/empty bundle file.'
    })
  }

  for (const addon of addons) {
    const prebuildIssues = await checkPrebuilds({ addon, hosts })
    issues.push(...prebuildIssues)
  }

  const runtimes: PlatformRuntime[] = []
  const advice: EnginesAdvice[] = []
  const malformed = new Set<string>()
  const platformOf = (host: string) =>
    bareKitPlatformOf(host) ?? (options.desktopRuntime === 'bare-kit-kotlin' ? 'android' : null)
  for (const platform of BARE_KIT_PLATFORMS) {
    const platformHosts = hosts.filter((host) => platformOf(host) === platform)
    if (platformHosts.length === 0) continue

    const resolution = await resolveBareKitRuntime({
      platform,
      projectRoot,
      bareStowDir: options.bareStowDir,
      network: options.network,
      onProgress: options.onProgress,
      fetchText: options.fetchText
    })
    runtimes.push({ platform, hosts: platformHosts, resolution })

    const abiIssues = checkAbi({
      addons: addonsLinkedOn(addons, platformHosts),
      runtime: resolution,
      packages: enginesPackages(diagnostics.packages),
      hosts: platformHosts
    }).filter((issue) => {
      // A malformed range is a property of the package, so it is reported once.
      if (issue.code !== 'malformed-engines-bare') return true
      if (malformed.has(issue.message)) return false
      malformed.add(issue.message)
      return true
    })
    issues.push(...abiIssues)

    const failures = abiIssues.flatMap((issue) =>
      issue.code === 'abi-mismatch' || issue.code === 'engines-mismatch'
        ? [
            failureOf(
              issue.code === 'abi-mismatch' ? issue.addon : issue.package,
              issue.enginesBare
            )
          ]
        : []
    )
    if (failures.length > 0 && resolution.resolved) {
      advice.push(
        await buildEnginesAdvice({
          projectRoot,
          hosts: platformHosts,
          runtime: resolution.runtime,
          failures,
          packages: diagnostics.packages,
          network: options.network,
          onProgress: options.onProgress,
          fetchPackageMetadata: options.fetchPackageMetadata
        })
      )
    }
  }

  const desktopHosts = hosts.filter((host) => platformOf(host) === null)
  if (desktopHosts.length > 0) {
    const resolution =
      options.desktopRuntime === 'pear-runtime'
        ? resolvePearRuntime(projectRoot)
        : resolveSidecarRuntime(projectRoot)
    runtimes.push({ platform: 'desktop', hosts: desktopHosts, resolution })
    issues.push(
      ...checkAbi({
        addons: addonsLinkedOn(addons, desktopHosts),
        runtime: resolution,
        packages: enginesPackages(diagnostics.packages),
        hosts: desktopHosts
      }).filter((issue) => issue.code !== 'malformed-engines-bare' || !malformed.has(issue.message))
    )
  }

  return {
    addonsSource,
    resolvedAddonsSource,
    sourceKind,
    hosts,
    runtimes,
    addons,
    issues,
    advice
  }
}

/** `name@version` ids as built by `formatAddonId`; scoped names keep their leading `@`. */
function failureOf(id: string, enginesBare: string) {
  const at = id.lastIndexOf('@')
  if (at <= 0) return { name: id, enginesBare }
  const version = id.slice(at + 1)
  return version === 'unknown'
    ? { name: id.slice(0, at), enginesBare }
    : { name: id.slice(0, at), version, enginesBare }
}

/**
 * Addons the given hosts load: those the bundle links on one of them.
 * Without link information (`linkedHosts` unset), every addon counts, as in
 * `checkPrebuilds`.
 */
function addonsLinkedOn(addons: NativeAddon[], hosts: string[]) {
  return addons.filter(
    (addon) =>
      addon.linkedHosts === undefined || addon.linkedHosts.some((host) => hosts.includes(host))
  )
}

function enginesPackages(records: PackageRecord[]): EnginesPackage[] {
  const byId = new Map<string, EnginesPackage>()
  for (const record of records) {
    if (record.isAddon || record.enginesBare === undefined) continue
    const id = `${record.name}@${record.version ?? 'unknown'}`
    if (byId.has(id)) continue
    const pkg: EnginesPackage = { name: record.name, enginesBare: record.enginesBare }
    if (record.version !== undefined) pkg.version = record.version
    byId.set(id, pkg)
  }
  return [...byId.values()]
}

function buildInvalidPackageJsonIssues(
  records: InvalidPackageJsonRecord[]
): InvalidPackageJsonIssue[] {
  return records.map((record) => {
    const issue: InvalidPackageJsonIssue = {
      code: 'invalid-package-json',
      level: 'warning',
      packageJsonPath: record.packageJsonPath,
      reason: record.reason,
      message:
        `Skipping ${record.expectedName ?? record.packageJsonPath}: ` +
        `${record.reason}. The package is being treated as a non-addon; if it ships ` +
        'native code, the verifier cannot check its prebuilds or ABI. ' +
        'Fix the package.json or remove the package.'
    }
    if (record.expectedName !== undefined) issue.expectedName = record.expectedName
    return issue
  })
}

async function detectSourceKind(resolvedAddonsSource: string): Promise<AddonSourceKind | null> {
  try {
    const stat = await fsp.stat(resolvedAddonsSource)
    if (stat.isFile()) return 'bare-pack-bundle'
    if (stat.isDirectory()) return 'node-modules'
    return null
  } catch {
    return null
  }
}

export function hasErrors(result: VerifyBundleResult): boolean {
  return result.issues.some((issue) => issue.level === 'error')
}

export function hasWarnings(result: VerifyBundleResult): boolean {
  return result.issues.some((issue) => issue.level === 'warning')
}

export function formatVerifyBundleResult(result: VerifyBundleResult): string {
  const sections: string[] = []
  const hostList = result.hosts.join(', ')

  if (result.issues.length === 0) {
    sections.push(
      `Native addon verification passed for ${result.addons.length} ` +
        `addon${result.addons.length === 1 ? '' : 's'} across ${result.hosts.length} ` +
        `host${result.hosts.length === 1 ? '' : 's'}: ${hostList}`
    )
    if (result.addons.length > 0) {
      sections.push('')
      sections.push('  Verified addons:')
      for (const addon of result.addons) {
        sections.push(`    - ${formatAddonId(addon)}`)
      }
    }
    return sections.join('\n')
  }

  if (hasErrors(result)) {
    sections.push('Native addon verification failed:')
  } else {
    sections.push('Native addon verification produced warnings:')
  }
  sections.push('')

  sections.push(...formatMissingPrebuilds(result.issues))
  sections.push(...formatAbiMismatches(result.issues))
  sections.push(...formatEnginesMismatches(result.issues))
  for (const advice of result.advice) sections.push(...formatEnginesAdvice(advice))
  sections.push(...formatMalformedEnginesBare(result.issues))
  sections.push(...formatInvalidPackageJsons(result.issues))
  sections.push(...formatEmptyBundleResolutions(result.issues))
  sections.push(...formatUnknownRuntime(result.issues))
  sections.push(...formatInvalidSources(result.issues))

  return sections.join('\n').trimEnd()
}

function formatMissingPrebuilds(issues: VerifyBundleIssue[]): string[] {
  const matches = issues.filter(
    (issue): issue is MissingPrebuildIssue => issue.code === 'missing-prebuild'
  )
  if (matches.length === 0) return []
  const lines = ['  Missing prebuild:']
  for (const issue of matches) {
    const pin = issue.platformPackage
    const needs =
      pin === undefined ? '' : ` (needs "${pin.name}": "${pin.version}" in package.json)`
    lines.push(`    - ${issue.addon} for ${issue.host}${needs}`)
  }
  lines.push('')
  return lines
}

function formatAbiMismatches(issues: VerifyBundleIssue[]): string[] {
  const matches = issues.filter(
    (issue): issue is Extract<AbiIssue, { code: 'abi-mismatch' }> => issue.code === 'abi-mismatch'
  )
  if (matches.length === 0) return []
  const lines = ['  ABI mismatch:']
  for (const issue of matches) {
    lines.push(
      `    - ${issue.addon} requires bare ${issue.enginesBare}, ` +
        `runtime is ${issue.runtimeVersion}${onHosts(issue.hosts)}`
    )
  }
  lines.push('')
  return lines
}

function formatEnginesMismatches(issues: VerifyBundleIssue[]): string[] {
  const matches = issues.filter(
    (issue): issue is Extract<AbiIssue, { code: 'engines-mismatch' }> =>
      issue.code === 'engines-mismatch'
  )
  if (matches.length === 0) return []
  const lines = ['  engines.bare mismatch:']
  for (const issue of matches) {
    lines.push(
      `    - ${issue.package} requires bare ${issue.enginesBare}, ` +
        `runtime is ${issue.runtimeVersion}${onHosts(issue.hosts)}`
    )
  }
  lines.push('')
  return lines
}

function onHosts(hosts: string[] | undefined) {
  return hosts === undefined ? '' : ` on ${hosts.join(', ')}`
}

function formatUnknownRuntime(issues: VerifyBundleIssue[]): string[] {
  const matches = issues.filter(
    (issue): issue is Extract<AbiIssue, { code: 'unknown-runtime-version' }> =>
      issue.code === 'unknown-runtime-version'
  )
  if (matches.length === 0) return []
  const lines = ['  Unknown runtime version:']
  for (const issue of matches) {
    lines.push(`    - ${issue.message}`)
  }
  lines.push('')
  return lines
}

function formatMalformedEnginesBare(issues: VerifyBundleIssue[]): string[] {
  const matches = issues.filter(
    (issue): issue is Extract<AbiIssue, { code: 'malformed-engines-bare' }> =>
      issue.code === 'malformed-engines-bare'
  )
  if (matches.length === 0) return []
  const lines = ['  Malformed engines.bare:']
  for (const issue of matches) {
    lines.push(`    - ${issue.message}`)
  }
  lines.push('')
  return lines
}

function formatInvalidSources(issues: VerifyBundleIssue[]): string[] {
  const matches = issues.filter(
    (issue): issue is InvalidSourceIssue => issue.code === 'invalid-source'
  )
  if (matches.length === 0) return []
  const lines = ['  Invalid source:']
  for (const issue of matches) {
    lines.push(`    - ${issue.message}`)
  }
  lines.push('')
  return lines
}

function formatInvalidPackageJsons(issues: VerifyBundleIssue[]): string[] {
  const matches = issues.filter(
    (issue): issue is InvalidPackageJsonIssue => issue.code === 'invalid-package-json'
  )
  if (matches.length === 0) return []
  const lines = ['  Invalid package.json (skipped):']
  for (const issue of matches) {
    lines.push(`    - ${issue.message}`)
  }
  lines.push('')
  return lines
}

function formatEmptyBundleResolutions(issues: VerifyBundleIssue[]): string[] {
  const matches = issues.filter(
    (issue): issue is EmptyBundleResolutionsIssue => issue.code === 'empty-bundle-resolutions'
  )
  if (matches.length === 0) return []
  const lines = ['  Empty bundle resolutions:']
  for (const issue of matches) {
    lines.push(`    - ${issue.message}`)
  }
  lines.push('')
  return lines
}
