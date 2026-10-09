import type stow from 'bare-stow'

export const BUNDLE_TARGETS = ['bare-sidecar', 'react-native', 'pear-runtime'] as const

export type BundleTarget = (typeof BUNDLE_TARGETS)[number]

interface TargetSpec {
  /** Harness file name inside `qvac/worker/`. */
  harness: string
  /** Native addons are written next to the bundle for the bundled hosts. */
  offload: boolean
  load(): Promise<stow.Target | stow.TargetName>
}

export const TARGETS: Record<BundleTarget, TargetSpec> = {
  'bare-sidecar': {
    harness: 'index.mjs',
    offload: true,
    load: async () => 'bare-sidecar'
  },
  'react-native': {
    harness: 'index.mjs',
    offload: false,
    load: async () => (await import('bare-stow-target-react-native')).default
  },
  'pear-runtime': {
    harness: 'index.cjs',
    offload: true,
    load: async () => (await import('bare-stow-target-pear-runtime')).default
  }
}

export function isBundleTarget(value: string): value is BundleTarget {
  return (BUNDLE_TARGETS as readonly string[]).includes(value)
}
