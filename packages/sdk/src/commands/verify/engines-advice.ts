import { promises as fsp } from 'node:fs'
import path from 'node:path'
import semver from 'semver'
import { formatRuntimeSource, type BareRuntime } from '@/commands/verify/abi'
import type { PackageRecord } from '@/commands/verify/addon-source'
import {
  findReactNativeBareKitUpgrade,
  NETWORK_TIMEOUT_MS,
  REACT_NATIVE_BARE_KIT,
  type ProgressFn
} from '@/commands/verify/bare-kit-runtime'
import { REACT_NATIVE_BARE_KIT_RUNTIMES } from '@/commands/verify/bare-kit-runtimes'

const REGISTRY_URL = 'https://registry.npmjs.org'

/** Abbreviated packuments list `engines` per version at a fraction of the full size. */
const ABBREVIATED_PACKUMENT = 'application/vnd.npm.install-v1+json'

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export interface EnginesFailure {
  name: string
  version?: string
  enginesBare: string
}

export interface EnginesParent {
  name: string
  range: string
  /** Whether the suggested override version satisfies this parent's range. */
  satisfied: boolean
}

export interface EnginesOverride {
  name: string
  installedVersions: string[]
  enginesBare: string[]
  /** Newest published version compatible with the runtime, or null if none was found. */
  version: string | null
  parents: EnginesParent[]
  snippet: string | null
  /** True when network lookups were disabled, so no version was searched for. */
  lookupSkipped?: boolean
  lookupError?: string
}

export interface EnginesUpgrade {
  packageName: string
  from: string
  to: string
  bare: string
}

export interface EnginesAdvice {
  hosts: string[]
  runtime: BareRuntime
  requiredBare: string
  upgrade: EnginesUpgrade | null
  upgradeHint: string
  overrides: EnginesOverride[]
  packageManager: PackageManager | null
}

export type FetchPackument = (name: string) => Promise<Packument>

export interface Packument {
  versions: Record<string, { engines?: { bare?: unknown } }>
}

export interface BuildEnginesAdviceOptions {
  projectRoot: string
  hosts: string[]
  runtime: BareRuntime
  failures: EnginesFailure[]
  packages: PackageRecord[]
  network?: boolean | undefined
  onProgress?: ProgressFn | undefined
  fetchPackument?: FetchPackument | undefined
}

export async function fetchPackument(name: string): Promise<Packument> {
  const url = `${REGISTRY_URL}/${name.replace('/', '%2f')}`
  const response = await fetch(url, {
    headers: { accept: ABBREVIATED_PACKUMENT },
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`)
  return (await response.json()) as Packument
}

const LOCKFILES: Array<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm']
]

async function exists(file: string) {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

async function readPackageManagerField(dir: string): Promise<PackageManager | null> {
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8')) as {
      packageManager?: unknown
    }
    if (typeof pkg.packageManager !== 'string') return null
    const name = pkg.packageManager.split('@')[0]
    return name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun' ? name : null
  } catch {
    return null
  }
}

/** Nearest `packageManager` field or lockfile, walking up to the workspace root. */
export async function detectPackageManager(projectRoot: string): Promise<PackageManager | null> {
  let dir = path.resolve(projectRoot)
  for (;;) {
    const fromField = await readPackageManagerField(dir)
    if (fromField !== null) return fromField
    for (const [lockfile, manager] of LOCKFILES) {
      if (await exists(path.join(dir, lockfile))) return manager
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function formatOverrideSnippet(
  manager: PackageManager | null,
  name: string,
  version: string,
  parents: string[]
) {
  let manifest: Record<string, unknown>
  switch (manager) {
    case 'pnpm':
      manifest = {
        pnpm: {
          overrides: Object.fromEntries(
            parents.length > 0 ? parents.map((p) => [`${p}>${name}`, version]) : [[name, version]]
          )
        }
      }
      break
    case 'yarn':
      manifest = {
        resolutions: Object.fromEntries(
          parents.length > 0 ? parents.map((p) => [`${p}/${name}`, version]) : [[name, version]]
        )
      }
      break
    case 'bun':
      // bun only supports top-level overrides.
      manifest = { overrides: { [name]: version } }
      break
    default:
      manifest = {
        overrides: Object.fromEntries(
          parents.length > 0 ? parents.map((p) => [p, { [name]: version }]) : [[name, version]]
        )
      }
  }
  return JSON.stringify(manifest, null, 2).replace(
    /\{\n\s+("[^"\n]+": "[^"\n]+")\n\s+\}/g,
    '{ $1 }'
  )
}

function groupFailures(failures: EnginesFailure[]) {
  const byName = new Map<string, { versions: Set<string>; ranges: Set<string> }>()
  for (const failure of failures) {
    let entry = byName.get(failure.name)
    if (entry === undefined) {
      entry = { versions: new Set(), ranges: new Set() }
      byName.set(failure.name, entry)
    }
    if (failure.version !== undefined) entry.versions.add(failure.version)
    entry.ranges.add(failure.enginesBare)
  }
  return byName
}

function findParents(name: string, packages: PackageRecord[]) {
  const seen = new Set<string>()
  const parents: Array<{ name: string; range: string }> = []
  for (const record of packages) {
    const range = record.dependencies[name]
    if (range === undefined) continue
    const key = `${record.name}\0${range}`
    if (seen.has(key)) continue
    seen.add(key)
    parents.push({ name: record.name, range })
  }
  return parents.sort((a, b) => a.name.localeCompare(b.name))
}

function runsOn(runtimeVersion: string, engines: { bare?: unknown } | undefined) {
  const range = engines?.bare
  if (typeof range !== 'string') return true
  return semver.validRange(range) !== null && semver.satisfies(runtimeVersion, range)
}

/**
 * Newest release that runs on the runtime and that every parent accepts,
 * else one that at least one parent accepts. Without known parents, only the
 * installed release line (`^installed`) is considered. A version no
 * dependent accepts would only trade one failure for another, so none is
 * suggested then.
 */
export function pickOverrideVersion(
  packument: Packument,
  runtimeVersion: string,
  installedVersions: string[],
  parentRanges: string[]
) {
  const compatible = Object.entries(packument.versions)
    .filter(([version, manifest]) => {
      if (semver.valid(version) === null || semver.prerelease(version) !== null) return false
      return runsOn(runtimeVersion, manifest.engines)
    })
    .map(([version]) => version)
    .sort(semver.rcompare)

  if (parentRanges.length > 0) {
    const acceptedByAll = compatible.find((version) =>
      parentRanges.every((range) => semver.satisfies(version, range))
    )
    if (acceptedByAll !== undefined) return acceptedByAll
    return (
      compatible.find((version) =>
        parentRanges.some((range) => semver.satisfies(version, range))
      ) ?? null
    )
  }

  const lines = installedVersions.filter((v) => semver.valid(v) !== null).map(releaseLine)
  return (
    compatible.find((version) => lines.some((range) => semver.satisfies(version, range))) ?? null
  )
}

/** Versions `^version` would treat as compatible, including older ones: 1.4.0 -> 1.x, 0.20.3 -> 0.20.x. */
function releaseLine(version: string) {
  const major = semver.major(version)
  const minor = semver.minor(version)
  if (major > 0) return `${major}.x`
  if (minor > 0) return `0.${minor}.x`
  return `0.0.${semver.patch(version)}`
}

function requiredBareVersion(ranges: string[]) {
  let required: string | null = null
  for (const range of ranges) {
    const min = semver.validRange(range) === null ? null : semver.minVersion(range)
    if (min !== null && (required === null || semver.gt(min.version, required))) {
      required = min.version
    }
  }
  return required ?? 'unknown'
}

function newestTableEntry() {
  const versions = Object.keys(REACT_NATIVE_BARE_KIT_RUNTIMES).sort(semver.rcompare)
  const newest = versions[0]
  return newest === undefined
    ? null
    : { version: newest, ...REACT_NATIVE_BARE_KIT_RUNTIMES[newest]! }
}

function buildUpgrade(runtime: BareRuntime, ranges: string[], requiredBare: string) {
  if (runtime.source === 'react-native-bare-kit' && runtime.packageVersion !== undefined) {
    const target = findReactNativeBareKitUpgrade(runtime.packageVersion, ranges)
    if (target !== null) {
      return {
        upgrade: {
          packageName: REACT_NATIVE_BARE_KIT,
          from: runtime.packageVersion,
          to: target.version,
          bare: target.bare
        },
        upgradeHint:
          `Upgrade ${REACT_NATIVE_BARE_KIT} to ${target.version} or newer ` +
          `(embeds bare-kit ${target.bareKit}, Bare ${target.bare}).`
      }
    }
    const newest = newestTableEntry()
    return {
      upgrade: null,
      upgradeHint:
        `No ${REACT_NATIVE_BARE_KIT} release in the built-in table embeds Bare ${requiredBare} or newer` +
        (newest === null
          ? '.'
          : `; the newest known, ${newest.version}, embeds Bare ${newest.bare}. Check for a newer release.`)
    }
  }

  if (runtime.source === 'bare-runtime' || runtime.source === 'bare') {
    return {
      upgrade: null,
      upgradeHint: `Upgrade ${runtime.source} to ${requiredBare} or newer.`
    }
  }

  return {
    upgrade: null,
    upgradeHint: `The runtime version comes from ${runtime.source}; raise it to ${requiredBare} or newer if the target runtime allows it.`
  }
}

export async function buildEnginesAdvice(
  options: BuildEnginesAdviceOptions
): Promise<EnginesAdvice> {
  const {
    projectRoot,
    hosts,
    runtime,
    failures,
    packages,
    network = true,
    onProgress,
    fetchPackument: fetchOne = fetchPackument
  } = options

  const grouped = groupFailures(failures)
  const allRanges = [...grouped.values()].flatMap((entry) => [...entry.ranges])
  const requiredBare = requiredBareVersion(allRanges)
  const packageManager = await detectPackageManager(projectRoot)

  const names = [...grouped.keys()].sort()
  if (network && names.length > 0) {
    onProgress?.(
      `Looking up releases of ${names.join(', ')} on registry.npmjs.org that run on Bare ` +
        `${runtime.version} (${names.length} request${names.length === 1 ? '' : 's'}, timeout ${NETWORK_TIMEOUT_MS / 1000}s)...`
    )
  }

  const overrides = await Promise.all(
    names.map(async (name) => {
      const entry = grouped.get(name)!
      const installedVersions = [...entry.versions].sort()
      const parents = findParents(name, packages)
      const override: EnginesOverride = {
        name,
        installedVersions,
        enginesBare: [...entry.ranges].sort(),
        version: null,
        parents: parents.map((parent) => ({ ...parent, satisfied: false })),
        snippet: null
      }
      if (!network) {
        override.lookupSkipped = true
        return override
      }
      try {
        const packument = await fetchOne(name)
        override.version = pickOverrideVersion(
          packument,
          runtime.version,
          installedVersions,
          parents.map((parent) => parent.range)
        )
      } catch (error) {
        override.lookupError = error instanceof Error ? error.message : String(error)
        return override
      }
      const version = override.version
      if (version === null) return override
      override.parents = parents.map((parent) => ({
        ...parent,
        satisfied: semver.satisfies(version, parent.range)
      }))
      // Scoping only matters when some dependent must keep its current copy.
      const accepting = override.parents.filter((parent) => parent.satisfied)
      override.snippet = formatOverrideSnippet(
        packageManager,
        name,
        version,
        accepting.length === override.parents.length ? [] : accepting.map((parent) => parent.name)
      )
      return override
    })
  )

  return {
    hosts,
    runtime,
    requiredBare,
    ...buildUpgrade(runtime, allRanges, requiredBare),
    overrides,
    packageManager
  }
}

const MANIFEST_FIELD: Record<PackageManager, string> = {
  npm: '"overrides"',
  pnpm: '"pnpm.overrides"',
  yarn: '"resolutions"',
  bun: '"overrides"'
}

export function formatEnginesAdvice(advice: EnginesAdvice): string[] {
  const lines = [
    `  Fix for ${advice.hosts.join(', ')}:`,
    `    Runtime: Bare ${advice.runtime.version} (from ${formatRuntimeSource(advice.runtime)})`,
    ...advice.overrides.map(
      (override) =>
        `    Requires: ${override.name}@${override.installedVersions.join(', ') || 'unknown'} needs Bare ${override.enginesBare.join(' and ')}`
    ),
    `    Option 1: ${advice.upgradeHint}`
  ]

  for (const override of advice.overrides) {
    const installed = override.installedVersions.join(', ') || 'unknown'
    if (override.lookupSkipped === true) {
      lines.push(
        `    Option 2 (${override.name}): pin an older release; run again with network lookups ` +
          'enabled (without --offline) to find one that runs on this Bare.'
      )
      continue
    }
    if (override.version === null) {
      const acceptedBy =
        override.parents.length === 0
          ? ` on the ${installed} release line`
          : ` that ${override.parents.map((p) => `${p.name} (${p.range})`).join(', ')} accept${override.parents.length === 1 ? 's' : ''}`
      lines.push(
        `    Option 2 (${override.name}): no release that runs on Bare ${advice.runtime.version}${acceptedBy} was found` +
          (override.lookupError === undefined
            ? '; upgrade the runtime.'
            : ` (${override.lookupError}).`)
      )
      continue
    }
    const field =
      advice.packageManager === null
        ? '"overrides" (npm/bun), "pnpm.overrides" or "resolutions" (yarn)'
        : MANIFEST_FIELD[advice.packageManager]
    lines.push(
      `    Option 2 (${override.name}): pin ${installed} -> ${override.version} with ${field} in your app's package.json:`
    )
    for (const line of (override.snippet ?? '').split('\n')) lines.push(`      ${line}`)
    const rejected = override.parents.filter((parent) => !parent.satisfied)
    if (rejected.length > 0) {
      lines.push(
        `      ${rejected.map((p) => `${p.name} (${p.range})`).join(', ')} ` +
          `${rejected.length === 1 ? 'does' : 'do'} not accept ${override.version}; ` +
          'those copies are left as they are.'
      )
    }
    if (advice.packageManager === 'bun' && override.parents.length > 0) {
      lines.push('      bun applies overrides to every copy in the tree.')
    }
  }

  lines.push('')
  return lines
}
