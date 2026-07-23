import path from 'node:path'
import {
  collectPackagesFromNpmLock,
  NPM_LOCKFILE,
  readNpmPackageLockAtRef,
  type PackageLockFile,
  type ReadNpmPackageLockAtRefOptions
} from './npm-lockfile.js'
import {
  collectNativePackages,
  type NativePackage,
  type UnclassifiedPackage
} from './native-packages.js'
import { LockfileNotFoundAtRefError, type LockfilePackage } from './lockfile.js'

export interface VerifyDepsOptions {
  projectRoot: string
  base: string
  head: string
  lockfilePath?: string
}

export interface NativePackageDiff {
  added: NativePackage[]
  removed: NativePackage[]
  unchanged: NativePackage[]
  unknownRemoved: UnclassifiedPackage[]
}

export interface VerifyDepsResult {
  base: string
  head: string
  diff: NativePackageDiff
  unclassifiedBase: UnclassifiedPackage[]
  unclassifiedHead: UnclassifiedPackage[]
  skippedReason?: string
}

interface PackageIdentity {
  name: string
  version?: string
}

function packageKey(pkg: PackageIdentity): string {
  return `${pkg.name}@${pkg.version ?? 'unknown'}`
}

function sortPackages<T extends PackageIdentity>(packages: T[]): T[] {
  return [...packages].sort((a, b) => packageKey(a).localeCompare(packageKey(b)))
}

export function formatNativePackage(pkg: PackageIdentity): string {
  return `${pkg.name}@${pkg.version ?? 'unknown'}`
}

export function diffNativePackages(
  basePackages: NativePackage[],
  headPackages: NativePackage[]
): NativePackageDiff {
  const baseByKey = new Map(basePackages.map((pkg) => [packageKey(pkg), pkg]))
  const headByKey = new Map(headPackages.map((pkg) => [packageKey(pkg), pkg]))

  const added: NativePackage[] = []
  const removed: NativePackage[] = []
  const unchanged: NativePackage[] = []

  for (const [key, pkg] of headByKey) {
    if (baseByKey.has(key)) unchanged.push(pkg)
    else added.push(pkg)
  }

  for (const [key, pkg] of baseByKey) {
    if (!headByKey.has(key)) removed.push(pkg)
  }

  return {
    added: sortPackages(added),
    removed: sortPackages(removed),
    unchanged: sortPackages(unchanged),
    unknownRemoved: []
  }
}

// lunte-disable-next-line require-await
async function nativePackagesForLock(
  packageRoot: string,
  packages: LockfilePackage[]
): Promise<{
  nativePackages: NativePackage[]
  unclassifiedPackages: UnclassifiedPackage[]
}> {
  return collectNativePackages({
    projectRoot: packageRoot,
    packages
  })
}

export function diffUnknownRemovedPackages(
  baseUnclassifiedPackages: UnclassifiedPackage[],
  headPackages: LockfilePackage[]
): UnclassifiedPackage[] {
  const headKeys = new Set(headPackages.map(packageKey))
  const unknownRemovedByKey = new Map<string, UnclassifiedPackage>()

  for (const pkg of baseUnclassifiedPackages) {
    const key = packageKey(pkg)
    if (!headKeys.has(key) && !unknownRemovedByKey.has(key)) {
      unknownRemovedByKey.set(key, pkg)
    }
  }

  return sortPackages([...unknownRemovedByKey.values()])
}

export function resolveLockfilePackageRoot(projectRoot: string, lockfilePath?: string): string {
  const resolvedLockfile = path.isAbsolute(lockfilePath ?? NPM_LOCKFILE)
    ? (lockfilePath ?? NPM_LOCKFILE)
    : path.join(projectRoot, lockfilePath ?? NPM_LOCKFILE)
  return path.dirname(resolvedLockfile)
}

export async function verifyDeps(options: VerifyDepsOptions): Promise<VerifyDepsResult> {
  const lockfilePath = options.lockfilePath ?? NPM_LOCKFILE
  const packageRoot = resolveLockfilePackageRoot(options.projectRoot, lockfilePath)
  const baseOptions: ReadNpmPackageLockAtRefOptions = {
    projectRoot: options.projectRoot,
    ref: options.base
  }
  const headOptions: ReadNpmPackageLockAtRefOptions = {
    projectRoot: options.projectRoot,
    ref: options.head
  }
  if (options.lockfilePath !== undefined) {
    baseOptions.lockfilePath = options.lockfilePath
    headOptions.lockfilePath = options.lockfilePath
  }

  const baseLock = await readOptionalNpmPackageLockAtRef(baseOptions)
  const headLock = await readOptionalNpmPackageLockAtRef(headOptions)

  if (baseLock === null && headLock === null) {
    const result: VerifyDepsResult = {
      base: options.base,
      head: options.head,
      diff: { added: [], removed: [], unchanged: [], unknownRemoved: [] },
      unclassifiedBase: [],
      unclassifiedHead: [],
      skippedReason:
        `No ${lockfilePath} found at either ${options.base} or ${options.head}; ` +
        'native dependency diff skipped.'
    }
    return result
  }

  const basePackages = baseLock === null ? [] : collectPackagesFromNpmLock(baseLock)
  const headPackages = headLock === null ? [] : collectPackagesFromNpmLock(headLock)

  const base =
    baseLock === null
      ? { nativePackages: [], unclassifiedPackages: [] }
      : await nativePackagesForLock(packageRoot, basePackages)
  const head =
    headLock === null
      ? { nativePackages: [], unclassifiedPackages: [] }
      : await nativePackagesForLock(packageRoot, headPackages)

  const diff = diffNativePackages(base.nativePackages, head.nativePackages)
  diff.unknownRemoved = diffUnknownRemovedPackages(base.unclassifiedPackages, headPackages)

  return {
    base: options.base,
    head: options.head,
    diff,
    unclassifiedBase: base.unclassifiedPackages,
    unclassifiedHead: head.unclassifiedPackages
  }
}

async function readOptionalNpmPackageLockAtRef(
  options: ReadNpmPackageLockAtRefOptions
): Promise<PackageLockFile | null> {
  try {
    return await readNpmPackageLockAtRef(options)
  } catch (error) {
    if (error instanceof LockfileNotFoundAtRefError) return null
    throw error
  }
}

function formatList(title: string, packages: NativePackage[], marker: string): string[] {
  if (packages.length === 0) return []
  return [
    `  ${title} (${packages.length}):`,
    ...packages.map((pkg) => `    ${marker} ${formatNativePackage(pkg)}`),
    ''
  ]
}

function formatUnknownRemovedList(packages: UnclassifiedPackage[]): string[] {
  if (packages.length === 0) return []
  return [
    `  Removed (unknown native status) (${packages.length}):`,
    ...packages.map((pkg) => `    ? ${formatNativePackage(pkg)}`),
    ''
  ]
}

export function hasNativeChanges(result: VerifyDepsResult): boolean {
  return (
    result.diff.added.length > 0 ||
    result.diff.removed.length > 0 ||
    result.diff.unknownRemoved.length > 0
  )
}

export function hasUnclassifiedPackages(result: VerifyDepsResult): boolean {
  return result.unclassifiedBase.length > 0 || result.unclassifiedHead.length > 0
}

function formatUnclassifiedWarning(result: VerifyDepsResult): string[] {
  const unknownRemovedKeys = new Set(result.diff.unknownRemoved.map(packageKey))
  const unclassifiedPackages = [
    ...result.unclassifiedBase.filter((pkg) => !unknownRemovedKeys.has(packageKey(pkg))),
    ...result.unclassifiedHead
  ]
  const total = unclassifiedPackages.length
  if (total === 0) return []

  return [
    '',
    `Warning: ${total} package${total === 1 ? '' : 's'} could not be classified because package metadata was unreadable.`,
    'Run the command from a checkout with dependencies installed for the selected npm lockfile.'
  ]
}

export function formatVerifyDepsResult(result: VerifyDepsResult): string {
  if (result.skippedReason) {
    return result.skippedReason
  }

  if (!hasNativeChanges(result)) {
    return `No native addon changes between ${result.base}..${result.head}.`
  }

  const lines = [
    `Native addon changes between ${result.base}..${result.head}:`,
    '',
    ...formatList('Added', result.diff.added, '+'),
    ...formatList('Removed', result.diff.removed, '-'),
    ...formatUnknownRemovedList(result.diff.unknownRemoved),
    'Confirm new natives and unknown removals are intentional.',
    'Run `qvac verify bundle` for full prebuild + ABI validation.',
    ...formatUnclassifiedWarning(result)
  ]

  return lines.join('\n')
}
