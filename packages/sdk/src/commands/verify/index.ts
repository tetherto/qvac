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
import {
  checkPrebuilds,
  isMobileHost,
  type MissingPrebuildIssue
} from '@/commands/verify/prebuilds'
import {
  checkAbi,
  type AbiIssue,
  type BareRuntimeResolution,
  type EnginesPackage
} from '@/commands/verify/abi'
import {
  resolveMobileBareRuntime,
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
   * Allow GitHub and npm registry requests: GitHub for a react-native-bare-kit
   * release newer than the built-in table, the registry only after a mismatch
   * is found, to suggest an override. Defaults to true.
   */
  network?: boolean
  /** Called before any step that waits on the network. */
  onProgress?: ProgressFn
  /** Test seams for the network lookups. */
  fetchText?: FetchText
  fetchPackageMetadata?: FetchPackageMetadata
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
   * Bare runtime of the mobile hosts, which ABI and engines.bare are checked
   * against. Null without mobile hosts: desktop hosts run the Bare that
   * bare-sidecar installs with the SDK.
   */
  runtime: BareRuntimeResolution | null
  addons: NativeAddon[]
  issues: VerifyBundleIssue[]
  /** How to fix packages that fail the mobile runtime's engines.bare check. */
  advice?: EnginesAdvice
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
      runtime: null,
      addons: [],
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
      runtime: null,
      addons: [],
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
        runtime: null,
        addons: [],
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

  const mobileHosts = hosts.filter(isMobileHost)
  let runtime: BareRuntimeResolution | null = null
  let advice: EnginesAdvice | undefined
  if (mobileHosts.length > 0) {
    runtime = await resolveMobileBareRuntime({
      projectRoot,
      network: options.network,
      onProgress: options.onProgress,
      fetchText: options.fetchText
    })
    const abiIssues = checkAbi({
      addons: addonsLinkedOn(addons, mobileHosts),
      runtime,
      packages: enginesPackages(diagnostics.packages)
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
    if (failures.length > 0 && runtime.resolved) {
      advice = await buildEnginesAdvice({
        projectRoot,
        hosts: mobileHosts,
        runtime: runtime.runtime,
        failures,
        packages: diagnostics.packages,
        network: options.network,
        onProgress: options.onProgress,
        fetchPackageMetadata: options.fetchPackageMetadata
      })
    }
  }

  const result: VerifyBundleResult = {
    addonsSource,
    resolvedAddonsSource,
    sourceKind,
    hosts,
    runtime,
    addons,
    issues
  }
  if (advice !== undefined) result.advice = advice
  return result
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
  if (result.advice !== undefined) sections.push(...formatEnginesAdvice(result.advice))
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
        `runtime is ${issue.runtimeVersion}`
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
        `runtime is ${issue.runtimeVersion}`
    )
  }
  lines.push('')
  return lines
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
