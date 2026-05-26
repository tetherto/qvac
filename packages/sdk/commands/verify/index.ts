import { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  resolveConfigFileInProject,
  loadConfigFromPath,
} from "@/client/config-loader/resolve-config.node";
import {
  createCollectDiagnostics,
  formatAddonId,
  type AddonSourceKind,
  type InvalidPackageJsonRecord,
  type NativeAddon,
} from "@/commands/verify/addon-source";
import {
  collectAddonsFromBundle,
  InvalidBundleSourceError,
} from "@/commands/verify/bundle-source";
import {
  collectAddonsFromNodeModules,
  InvalidNodeModulesSourceError,
} from "@/commands/verify/node-modules-source";
import {
  checkPrebuilds,
  type MissingPrebuildIssue,
} from "@/commands/verify/prebuilds";
import {
  checkAbi,
  formatConfigLabel,
  normalizeVersion,
  resolveBareRuntime,
  type AbiIssue,
  type BareRuntimeResolution,
} from "@/commands/verify/abi";

export interface VerifyBundleOptions {
  projectRoot: string
  addonsSource: string
  hosts: string[]
  bareRuntimeVersion?: string
  configPath?: string
}

export interface InvalidSourceIssue {
  code: 'invalid-source'
  level: 'error'
  message: string
  addonsSource: string
}

export interface InvalidRuntimeVersionIssue {
  code: 'invalid-runtime-version'
  level: 'error'
  message: string
  providedValue: string
  source: 'flag' | 'config'
}

export interface ConfigLoadFailedIssue {
  code: 'config-load-failed'
  level: 'warning'
  message: string
  configPath: string
  reason: string
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
  | InvalidRuntimeVersionIssue
  | ConfigLoadFailedIssue
  | InvalidPackageJsonIssue
  | EmptyBundleResolutionsIssue

export interface VerifyBundleResult {
  addonsSource: string
  resolvedAddonsSource: string
  sourceKind: AddonSourceKind | null
  hosts: string[]
  runtime: BareRuntimeResolution | null
  addons: NativeAddon[]
  issues: VerifyBundleIssue[]
}

export async function verifyBundle (
  options: VerifyBundleOptions
): Promise<VerifyBundleResult> {
  const { projectRoot, addonsSource, hosts, bareRuntimeVersion, configPath } = options
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

  let invalidRuntimeVersion: InvalidRuntimeVersionIssue | null = null
  if (bareRuntimeVersion !== undefined && normalizeVersion(bareRuntimeVersion) === null) {
    invalidRuntimeVersion = {
      code: 'invalid-runtime-version',
      level: 'error',
      providedValue: bareRuntimeVersion,
      source: 'flag',
      message:
        `bareRuntimeVersion "${bareRuntimeVersion}" is not a valid semver. ` +
        'Use a version like 1.15.0 (with optional v-prefix and pre-release tag) or omit it to use auto-detection.'
    }
  }

  let configRuntimeVersion: string | undefined
  let resolvedConfigPath: string | null = null
  let configLoadFailed: ConfigLoadFailedIssue | null = null
  try {
    resolvedConfigPath = await resolveConfigFileInProject(
      projectRoot,
      configPath ?? undefined,
    )
    if (resolvedConfigPath !== null) {
      const config = await loadConfigFromPath(resolvedConfigPath)
      if (typeof config.bareRuntimeVersion === "string") {
        configRuntimeVersion = config.bareRuntimeVersion;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (configPath !== undefined) {
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
            message: `Failed to load config from '${configPath}': ${message}`
          }
        ]
      }
    }
    if (resolvedConfigPath !== null) {
      configLoadFailed = {
        code: 'config-load-failed',
        level: 'warning',
        configPath: resolvedConfigPath,
        reason: message,
        message:
          `Found ${formatConfigLabel(projectRoot, resolvedConfigPath)} but failed to load it: ${message}. ` +
          'Falling back to auto-detection for Bare runtime; the project-pinned ' +
          '`bareRuntimeVersion` is being ignored. Fix the config file or pass `configPath` explicitly to surface it as an error.'
      }
    }
  }

  if (
    invalidRuntimeVersion === null &&
    bareRuntimeVersion === undefined &&
    configRuntimeVersion !== undefined &&
    normalizeVersion(configRuntimeVersion) === null
  ) {
    invalidRuntimeVersion = {
      code: 'invalid-runtime-version',
      level: 'error',
      providedValue: configRuntimeVersion,
      source: 'config',
      message:
        `\`bareRuntimeVersion\` in ${formatConfigLabel(projectRoot, resolvedConfigPath ?? undefined)} ` +
        `"${configRuntimeVersion}" is not a valid semver. ` +
        'Use a version like 1.15.0 (with optional v-prefix and pre-release tag), or remove the field to use auto-detection.'
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
  let addons: NativeAddon[]
  try {
    addons = sourceKind === 'bare-pack-bundle'
      ? await collectAddonsFromBundle({
        bundlePath: resolvedAddonsSource,
        projectRoot,
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
  if (configLoadFailed !== null) issues.push(configLoadFailed)
  if (invalidRuntimeVersion !== null) issues.push(invalidRuntimeVersion)
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

  let runtime: BareRuntimeResolution | null = null
  if (invalidRuntimeVersion === null) {
    const runtimeOptions: Parameters<typeof resolveBareRuntime>[0] = { projectRoot }
    if (bareRuntimeVersion !== undefined) {
      runtimeOptions.explicitVersion = bareRuntimeVersion
      runtimeOptions.explicitSource = 'flag'
    } else if (configRuntimeVersion !== undefined) {
      runtimeOptions.explicitVersion = configRuntimeVersion
      runtimeOptions.explicitSource = 'config'
    }
    runtime = await resolveBareRuntime(runtimeOptions)
    issues.push(...checkAbi({ addons, runtime }))
  }

  return {
    addonsSource,
    resolvedAddonsSource,
    sourceKind,
    hosts,
    runtime,
    addons,
    issues
  }
}

function buildInvalidPackageJsonIssues (
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

async function detectSourceKind (
  resolvedAddonsSource: string
): Promise<AddonSourceKind | null> {
  try {
    const stat = await fsp.stat(resolvedAddonsSource)
    if (stat.isFile()) return 'bare-pack-bundle'
    if (stat.isDirectory()) return 'node-modules'
    return null
  } catch {
    return null
  }
}

export function hasErrors (result: VerifyBundleResult): boolean {
  return result.issues.some((issue) => issue.level === 'error')
}

export function hasWarnings (result: VerifyBundleResult): boolean {
  return result.issues.some((issue) => issue.level === 'warning')
}

export function formatVerifyBundleResult (result: VerifyBundleResult): string {
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
  sections.push(...formatInvalidRuntimeVersions(result.issues))
  sections.push(...formatMalformedEnginesBare(result.issues))
  sections.push(...formatConfigLoadFailed(result.issues))
  sections.push(...formatInvalidPackageJsons(result.issues))
  sections.push(...formatEmptyBundleResolutions(result.issues))
  sections.push(...formatUnknownRuntime(result.issues))
  sections.push(...formatInvalidSources(result.issues))

  return sections.join('\n').trimEnd()
}

function formatConfigLoadFailed (issues: VerifyBundleIssue[]): string[] {
  const matches = issues.filter(
    (issue): issue is ConfigLoadFailedIssue => issue.code === 'config-load-failed'
  )
  if (matches.length === 0) return []
  const lines = ['  Config load failed:']
  for (const issue of matches) {
    lines.push(`    - ${issue.message}`)
  }
  lines.push('')
  return lines
}

function formatMissingPrebuilds (issues: VerifyBundleIssue[]): string[] {
  const matches = issues.filter(
    (issue): issue is MissingPrebuildIssue => issue.code === 'missing-prebuild'
  )
  if (matches.length === 0) return []
  const lines = ['  Missing prebuild:']
  for (const issue of matches) {
    lines.push(`    - ${issue.addon} for ${issue.host}`)
  }
  lines.push('')
  return lines
}

function formatAbiMismatches (issues: VerifyBundleIssue[]): string[] {
  const matches = issues.filter(
    (issue): issue is Extract<AbiIssue, { code: 'abi-mismatch' }> =>
      issue.code === 'abi-mismatch'
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

function formatUnknownRuntime (issues: VerifyBundleIssue[]): string[] {
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

function formatMalformedEnginesBare (issues: VerifyBundleIssue[]): string[] {
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

function formatInvalidSources (issues: VerifyBundleIssue[]): string[] {
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

function formatInvalidRuntimeVersions (issues: VerifyBundleIssue[]): string[] {
  const matches = issues.filter(
    (issue): issue is InvalidRuntimeVersionIssue =>
      issue.code === 'invalid-runtime-version'
  )
  if (matches.length === 0) return []
  const lines = ['  Invalid Bare runtime version:']
  for (const issue of matches) {
    lines.push(`    - ${issue.message}`)
  }
  lines.push('')
  return lines
}

function formatInvalidPackageJsons (issues: VerifyBundleIssue[]): string[] {
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

function formatEmptyBundleResolutions (issues: VerifyBundleIssue[]): string[] {
  const matches = issues.filter(
    (issue): issue is EmptyBundleResolutionsIssue =>
      issue.code === 'empty-bundle-resolutions'
  )
  if (matches.length === 0) return []
  const lines = ['  Empty bundle resolutions:']
  for (const issue of matches) {
    lines.push(`    - ${issue.message}`)
  }
  lines.push('')
  return lines
}
