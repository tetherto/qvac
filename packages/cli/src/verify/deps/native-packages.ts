import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { LockfilePackage } from './lockfile.js'

interface PackageJson {
  addon?: boolean
}

export interface NativePackage {
  lockPath: string
  name: string
  version?: string
  packageJsonPath: string
}

export interface UnclassifiedPackage {
  lockPath: string
  name: string
  version?: string
  packageJsonPath: string
  reason: string
}

export interface CollectNativePackagesOptions {
  projectRoot: string
  packages: LockfilePackage[]
}

export interface CollectNativePackagesResult {
  nativePackages: NativePackage[]
  unclassifiedPackages: UnclassifiedPackage[]
}

function withVersion<T extends { version?: string }>(
  target: Omit<T, 'version'>,
  version: string | undefined
): T {
  const next = { ...target } as T
  if (version !== undefined) next.version = version
  return next
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJson> {
  const raw = await fsp.readFile(packageJsonPath, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('package.json must contain an object')
  }
  return parsed as PackageJson
}

function packageJsonPathForLockPath(projectRoot: string, lockPath: string): string {
  return path.join(projectRoot, lockPath, 'package.json')
}

export async function collectNativePackages(
  options: CollectNativePackagesOptions
): Promise<CollectNativePackagesResult> {
  const nativePackages: NativePackage[] = []
  const unclassifiedPackages: UnclassifiedPackage[] = []

  for (const pkg of options.packages) {
    const packageJsonPath = packageJsonPathForLockPath(options.projectRoot, pkg.lockPath)

    let packageJson: PackageJson
    try {
      packageJson = await readPackageJson(packageJsonPath)
    } catch (error) {
      unclassifiedPackages.push(
        withVersion<UnclassifiedPackage>(
          {
            lockPath: pkg.lockPath,
            name: pkg.name,
            packageJsonPath,
            reason: error instanceof Error ? error.message : String(error)
          },
          pkg.version
        )
      )
      continue
    }

    if (packageJson.addon === true) {
      nativePackages.push(
        withVersion<NativePackage>(
          {
            lockPath: pkg.lockPath,
            name: pkg.name,
            packageJsonPath
          },
          pkg.version
        )
      )
    }
  }

  return { nativePackages, unclassifiedPackages }
}
