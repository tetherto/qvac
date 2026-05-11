import path from 'node:path'
import {
  LockfileReadError,
  readLockfileTextAtRef,
  type LockfilePackage
} from './lockfile.js'

export const NPM_LOCKFILE = 'package-lock.json'

export interface PackageLockEntry {
  name?: string
  version?: string
}

export interface PackageLockFile {
  lockfileVersion?: number
  packages?: Record<string, PackageLockEntry>
}

export interface ReadNpmPackageLockAtRefOptions {
  projectRoot: string
  ref: string
  lockfilePath?: string
}

export class UnsupportedLockfileError extends Error {
  constructor (lockfilePath: string) {
    super(
      `Unsupported lockfile: ${lockfilePath}\n\n` +
      `  qvac verify deps currently supports npm ${NPM_LOCKFILE} files only.\n` +
      '  Yarn, Bun, and pnpm lockfiles are planned follow-ups.'
    )
    this.name = 'UnsupportedLockfileError'
  }
}

export function assertSupportedNpmLockfile (lockfilePath: string): void {
  if (path.basename(lockfilePath) !== NPM_LOCKFILE) {
    throw new UnsupportedLockfileError(lockfilePath)
  }
}

export function parseNpmPackageLock (
  raw: string,
  sourceLabel = NPM_LOCKFILE
): PackageLockFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new LockfileReadError(`Failed to parse ${sourceLabel}`, error)
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LockfileReadError(`${sourceLabel} must contain a JSON object`)
  }

  const lock = parsed as PackageLockFile
  if (lock.packages !== undefined && (
    typeof lock.packages !== 'object' ||
    lock.packages === null ||
    Array.isArray(lock.packages)
  )) {
    throw new LockfileReadError(`${sourceLabel} "packages" must be an object`)
  }

  return lock
}

export async function readNpmPackageLockAtRef (
  options: ReadNpmPackageLockAtRefOptions
): Promise<PackageLockFile> {
  const lockfilePath = options.lockfilePath ?? NPM_LOCKFILE
  assertSupportedNpmLockfile(lockfilePath)

  const raw = await readLockfileTextAtRef({
    projectRoot: options.projectRoot,
    ref: options.ref,
    lockfilePath
  })
  return parseNpmPackageLock(raw, `${options.ref}:${lockfilePath}`)
}

export function packageNameFromNpmLockPath (lockPath: string): string | null {
  const parts = lockPath.split('/').filter(Boolean)
  let name: string | null = null

  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== 'node_modules') continue

    const first = parts[i + 1]
    if (!first) return null

    if (first.startsWith('@')) {
      const second = parts[i + 2]
      if (!second) return null
      name = `${first}/${second}`
      i += 2
    } else {
      name = first
      i += 1
    }
  }

  return name
}

export function collectPackagesFromNpmLock (
  lock: PackageLockFile
): LockfilePackage[] {
  const entries = lock.packages ?? {}
  const packages: LockfilePackage[] = []

  for (const [lockPath, entry] of Object.entries(entries)) {
    if (lockPath.length === 0) continue

    const name = packageNameFromNpmLockPath(lockPath)
    if (!name) continue

    const lockPackage: LockfilePackage = { lockPath, name }
    if (typeof entry.version === 'string') {
      lockPackage.version = entry.version
    }
    packages.push(lockPackage)
  }

  return packages
}
