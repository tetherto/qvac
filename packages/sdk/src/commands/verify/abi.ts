import { promises as fsp } from 'node:fs'
import path from 'node:path'
import semver from 'semver'
import { formatAddonId, type NativeAddon } from '@/commands/verify/addon-source'

export interface BareRuntime {
  version: string
  source: 'flag' | 'config' | 'bare-runtime' | 'bare' | 'react-native-bare-kit'
  /** Installed version of the package named by `source`, when it differs from `version`. */
  packageVersion?: string
  detail?: string
}

export interface UnresolvedBareRuntime {
  reason: string
  triedPaths: string[]
}

export interface ResolveBareRuntimeOptions {
  projectRoot: string
  explicitVersion?: string
  explicitSource?: 'flag' | 'config'
}

export type BareRuntimeResolution =
  { resolved: true; runtime: BareRuntime } | { resolved: false; error: UnresolvedBareRuntime }

export interface AbiMismatchIssue {
  code: 'abi-mismatch'
  level: 'error'
  addon: string
  message: string
  enginesBare: string
  runtimeVersion: string
}

/** A bundled package that is not an addon but still declares engines.bare. */
export interface EnginesMismatchIssue {
  code: 'engines-mismatch'
  level: 'error'
  package: string
  message: string
  enginesBare: string
  runtimeVersion: string
}

export interface UnknownRuntimeIssue {
  code: 'unknown-runtime-version'
  level: 'warning'
  message: string
  triedPaths: string[]
}

export interface MalformedEnginesBareIssue {
  code: 'malformed-engines-bare'
  level: 'warning'
  addon: string
  enginesBare: string
  message: string
}

export type AbiIssue =
  AbiMismatchIssue | EnginesMismatchIssue | UnknownRuntimeIssue | MalformedEnginesBareIssue

export interface CheckAbiOptions {
  addons: NativeAddon[]
  runtime: BareRuntimeResolution
  /** Non-addon packages that declare engines.bare. */
  packages?: EnginesPackage[] | undefined
}

export interface EnginesPackage {
  name: string
  version?: string
  enginesBare: string
}

const RUNTIME_PACKAGES: Array<{
  source: BareRuntime['source']
  packageName: string
}> = [
  { source: 'bare-runtime', packageName: 'bare-runtime' },
  { source: 'bare', packageName: 'bare' }
]

export async function resolveBareRuntime(
  options: ResolveBareRuntimeOptions
): Promise<BareRuntimeResolution> {
  if (options.explicitVersion) {
    // Caller (verifyBundle) pre-validates explicitVersion via normalizeVersion.
    return {
      resolved: true,
      runtime: {
        version: normalizeVersion(options.explicitVersion)!,
        source: options.explicitSource ?? 'flag'
      }
    }
  }

  const tried: string[] = []
  for (const candidate of RUNTIME_PACKAGES) {
    const pkgJsonPath = path.join(
      options.projectRoot,
      'node_modules',
      candidate.packageName,
      'package.json'
    )
    tried.push(pkgJsonPath)
    const version = await tryReadRuntimeVersion(pkgJsonPath)
    if (version) {
      return {
        resolved: true,
        runtime: { version, source: candidate.source }
      }
    }
  }

  return {
    resolved: false,
    error: {
      reason: 'Unable to detect installed Bare runtime version',
      triedPaths: tried
    }
  }
}

async function tryReadRuntimeVersion(pkgJsonPath: string): Promise<string | null> {
  let raw: string
  try {
    raw = await fsp.readFile(pkgJsonPath, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const version = (parsed as Record<string, unknown>)['version']
  return typeof version === 'string' ? normalizeVersion(version) : null
}

export function normalizeVersion(value: string): string | null {
  const coerced = semver.coerce(value, { includePrerelease: true })
  return coerced ? coerced.version : null
}

export function formatConfigLabel(projectRoot: string, configPath?: string): string {
  if (!configPath) return 'qvac.config'
  const rel = path.relative(projectRoot, configPath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return configPath
  return rel
}

export function formatRuntimeSource(runtime: BareRuntime) {
  return runtime.detail === undefined ? runtime.source : `${runtime.source}: ${runtime.detail}`
}

export function checkAbi(options: CheckAbiOptions): AbiIssue[] {
  const { addons, runtime, packages = [] } = options
  const constrained = [
    ...addons.map((addon) => ({
      id: formatAddonId(addon),
      range: addon.enginesBare,
      isAddon: true
    })),
    ...packages.map((pkg) => ({ id: formatAddonId(pkg), range: pkg.enginesBare, isAddon: false }))
  ].filter((entry): entry is { id: string; range: string; isAddon: boolean } => !!entry.range)
  if (constrained.length === 0) return []

  const issues: AbiIssue[] = []
  const checkable: typeof constrained = []

  for (const entry of constrained) {
    if (!semver.validRange(entry.range)) {
      issues.push({
        code: 'malformed-engines-bare',
        level: 'warning',
        addon: entry.id,
        enginesBare: entry.range,
        message:
          `${entry.id} declares engines.bare "${entry.range}", which is ` +
          `not a valid semver range. ABI check skipped for this ${entry.isAddon ? 'addon' : 'package'}. ` +
          'Report this to the package maintainer.'
      })
      continue
    }
    checkable.push(entry)
  }

  if (checkable.length === 0) return issues

  if (!runtime.resolved) {
    issues.push({
      code: 'unknown-runtime-version',
      level: 'warning',
      message:
        `${runtime.error.reason}. ABI checks skipped for ${checkable.length} ` +
        `package${checkable.length === 1 ? '' : 's'}. ` +
        'Pass bareRuntimeVersion to enable strict ABI verification.',
      triedPaths: runtime.error.triedPaths
    })
    return issues
  }

  const { version } = runtime.runtime
  for (const entry of checkable) {
    if (semver.satisfies(version, entry.range)) continue
    const message =
      `${entry.id} requires bare ${entry.range}, ` +
      `runtime is ${version} (from ${formatRuntimeSource(runtime.runtime)}).`
    if (entry.isAddon) {
      issues.push({
        code: 'abi-mismatch',
        level: 'error',
        addon: entry.id,
        enginesBare: entry.range,
        runtimeVersion: version,
        message
      })
    } else {
      issues.push({
        code: 'engines-mismatch',
        level: 'error',
        package: entry.id,
        enginesBare: entry.range,
        runtimeVersion: version,
        message
      })
    }
  }

  return issues
}
