import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type stow from 'bare-stow'
import { BundleTargetNotInstalledError } from '@/utils/errors-client'

export const BUNDLE_TARGETS = ['bare-sidecar', 'react-native', 'pear-runtime'] as const

export type BundleTarget = (typeof BUNDLE_TARGETS)[number]

interface TargetSpec {
  /** Harness file name inside `qvac/worker/`. */
  harness: string
  load(projectRoot: string): Promise<stow.Target | stow.TargetName>
}

export async function loadTargetPackage(
  target: BundleTarget,
  packageName: string,
  projectRoot: string
): Promise<stow.Target> {
  for (const from of [path.join(projectRoot, 'package.json'), import.meta.url]) {
    let resolved: string
    try {
      resolved = createRequire(from).resolve(packageName)
    } catch {
      continue
    }
    return ((await import(pathToFileURL(resolved).href)) as { default: stow.Target }).default
  }
  throw new BundleTargetNotInstalledError(target, packageName)
}

export const TARGETS: Record<BundleTarget, TargetSpec> = {
  'bare-sidecar': {
    harness: 'index.mjs',
    load: async () => 'bare-sidecar'
  },
  'react-native': {
    harness: 'index.mjs',
    load: (projectRoot) =>
      loadTargetPackage('react-native', 'bare-stow-target-react-native', projectRoot)
  },
  'pear-runtime': {
    harness: 'index.cjs',
    load: (projectRoot) =>
      loadTargetPackage('pear-runtime', 'bare-stow-target-pear-runtime', projectRoot)
  }
}

export function isBundleTarget(value: string): value is BundleTarget {
  return (BUNDLE_TARGETS as readonly string[]).includes(value)
}
