import { describe, expect, it } from 'vitest'
import {
  validateArtifacts,
  type ExecutionRealm,
  type NativeAddonIdentity,
  type PackageInstance
} from '../lib/artifact-validation.ts'

const cleanAddon = { name: 'sodium-native', version: '5.1.0' } as const

describe('artifact validation', () => {
  it('allows different singleton versions in isolated worker realms', async () => {
    const report = await validateArtifacts(
      fixture({
        realms: [
          realm('sync', [
            pkg('bare-signals', '4.2.0', true),
            pkg('sodium-native', '5.1.0', true)
          ]),
          realm('harness', [pkg('bare-signals', '5.0.0', true)])
        ]
      })
    )
    expect(report.ok).toBe(true)
  })

  it('rejects duplicate singleton versions inside one realm', async () => {
    const report = await validateArtifacts(
      fixture({
        realms: [
          realm('sync', [
            pkg('bare-signals', '4.2.0', true, '/one'),
            pkg('bare-signals', '5.0.0', true, '/two')
          ])
        ]
      })
    )
    expect(report.errors.map((issue) => issue.code)).toContain(
      'DUPLICATE_SINGLETON_VERSION'
    )
  })

  it('rejects conflicting native addon versions', async () => {
    const report = await validateArtifacts(
      fixture({
        sdkAddons: [{ name: 'sodium-native', version: '5.0.0' }],
        workers: [{ name: 'sync', nativeAddons: [cleanAddon] }],
        mergedAddons: [cleanAddon]
      })
    )
    expect(report.errors.map((issue) => issue.code)).toContain(
      'CONFLICTING_NATIVE_ADDON_VERSION'
    )
  })

  it('rejects missing native prebuilds and undeclared merged addons', async () => {
    const report = await validateArtifacts(
      fixture({
        mergedAddons: [
          cleanAddon,
          { name: 'udx-native', version: '1.17.8' }
        ],
        stagedResources: []
      })
    )
    expect(report.errors.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'UNDECLARED_MERGED_ADDON',
        'MISSING_NATIVE_PREBUILD'
      ])
    )
  })

  it('accepts a clean composed stack with staged native resources', async () => {
    const report = await validateArtifacts(
      fixture({
        stagedResources: [
          'lib/arm64-v8a/libsodium-native.5.1.0.so'
        ]
      })
    )
    expect(report.ok).toBe(true)
    expect(report.nativeAddons).toEqual([cleanAddon])
  })

  it('rejects a staged scoped addon that no bundle declared', async () => {
    const report = await validateArtifacts(
      fixture({
        stagedResources: [
          'lib/arm64-v8a/libsodium-native.5.1.0.so',
          'lib/arm64-v8a/libqvac__rogue.1.0.0.so'
        ]
      })
    )
    expect(report.errors.map((issue) => issue.code)).toContain(
      'UNDECLARED_STAGED_ADDON'
    )
  })
})

function fixture(
  overrides: Partial<{
    realms: readonly ExecutionRealm[]
    sdkAddons: readonly NativeAddonIdentity[]
    workers: readonly {
      readonly name: string
      readonly nativeAddons: readonly NativeAddonIdentity[]
    }[]
    mergedAddons: readonly NativeAddonIdentity[]
    stagedResources: readonly string[]
  }> = {}
) {
  return {
    projectRoot: '/unused',
    realms: overrides.realms ?? [realm('sync', [pkg('sodium-native', '5.1.0', true)])],
    singletonPackages: ['sodium-native'],
    sdkAddons: overrides.sdkAddons ?? [],
    workers:
      overrides.workers ?? [{ name: 'sync', nativeAddons: [cleanAddon] }],
    mergedAddons: overrides.mergedAddons ?? [cleanAddon],
    ...(overrides.stagedResources
      ? { stagedResources: overrides.stagedResources }
      : {})
  }
}

function realm(name: string, packages: readonly PackageInstance[]): ExecutionRealm {
  return { name, roots: [], packages }
}

function pkg(
  name: string,
  version: string,
  singleton: boolean,
  packagePath = `/node_modules/${name}/${version}`
): PackageInstance {
  return { name, version, singleton, packagePath }
}
