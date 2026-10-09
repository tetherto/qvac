import semver from 'semver'
import { formatAddonId, type NativeAddon } from '@/commands/verify/addon-source'

/** The Bare build inside the app's react-native-bare-kit, which phone hosts run. */
export interface BareRuntime {
  version: string
  source: 'react-native-bare-kit'
  /** Installed react-native-bare-kit version. */
  packageVersion: string
  detail: string
}

export interface UnresolvedBareRuntime {
  reason: string
  triedPaths: string[]
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

export function formatRuntimeSource(runtime: BareRuntime) {
  return `${runtime.source}: ${runtime.detail}`
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
        `package${checkable.length === 1 ? '' : 's'}.`,
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
