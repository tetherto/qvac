import { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  formatAddonId,
  type AddonSourceKind,
  type NativeAddon
} from './addon-source.js'
import {
  collectAddonsFromBundle,
  InvalidBundleSourceError
} from './bundle-source.js'
import {
  collectAddonsFromNodeModules,
  InvalidNodeModulesSourceError
} from './node-modules-source.js'
import { checkPrebuilds, type MissingPrebuildIssue } from './prebuilds.js'
import {
  checkAbi,
  normalizeVersion,
  resolveBareRuntime,
  type AbiIssue,
  type BareRuntimeResolution
} from './abi.js'

export interface VerifyBundleOptions {
  projectRoot: string
  addonsSource: string
  hosts: string[]
  bareRuntimeVersion?: string
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
}

export type VerifyBundleIssue =
  | MissingPrebuildIssue
  | AbiIssue
  | InvalidSourceIssue
  | InvalidRuntimeVersionIssue

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
  const { projectRoot, addonsSource, hosts, bareRuntimeVersion } = options
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
          message: 'At least one --host is required.'
        }
      ]
    }
  }

  if (bareRuntimeVersion !== undefined && normalizeVersion(bareRuntimeVersion) === null) {
    return {
      addonsSource,
      resolvedAddonsSource,
      sourceKind: null,
      hosts,
      runtime: null,
      addons: [],
      issues: [
        {
          code: 'invalid-runtime-version',
          level: 'error',
          providedValue: bareRuntimeVersion,
          message:
            `--bare-runtime-version "${bareRuntimeVersion}" is not a valid semver. ` +
            'Pass a version like 1.15.0 (with optional v-prefix and pre-release tag) or omit the flag to use auto-detection.'
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

  let addons: NativeAddon[]
  try {
    addons = sourceKind === 'bare-pack-bundle'
      ? await collectAddonsFromBundle({
        bundlePath: resolvedAddonsSource,
        projectRoot
      })
      : await collectAddonsFromNodeModules({
        nodeModulesRoot: resolvedAddonsSource
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

  for (const addon of addons) {
    const prebuildIssues = await checkPrebuilds({ addon, hosts })
    issues.push(...prebuildIssues)
  }

  const runtimeOptions: Parameters<typeof resolveBareRuntime>[0] = { projectRoot }
  if (bareRuntimeVersion) runtimeOptions.explicitVersion = bareRuntimeVersion
  const runtime = await resolveBareRuntime(runtimeOptions)
  issues.push(...checkAbi({ addons, runtime }))

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
  sections.push(...formatUnknownRuntime(result.issues))
  sections.push(...formatInvalidSources(result.issues))

  return sections.join('\n').trimEnd()
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
  const lines = ['  Invalid --bare-runtime-version:']
  for (const issue of matches) {
    lines.push(`    - ${issue.message}`)
  }
  lines.push('')
  return lines
}
