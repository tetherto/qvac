export const requiredMobileHosts = [
  'android-arm64',
  'ios-arm64',
  'ios-arm64-simulator',
  'ios-x64-simulator'
] as const

export interface NativeAddonIdentity {
  readonly name: string
  readonly version: string
}

export interface PackageIdentity {
  readonly name: string
  readonly version: string
  readonly packagePath: string
  readonly singleton: boolean
}

export interface SyncBuildMetadata {
  readonly bundleId: string | null
  readonly contract: string
  readonly protocolVersion: number
  readonly hosts: readonly string[]
  readonly nativeAddons: readonly string[]
  readonly packages?: readonly PackageIdentity[]
}

export interface SyncBuildResult {
  readonly descriptor: {
    readonly entryPath: string
    readonly harnessPath: string
    readonly metadataPath: string
    readonly contract: 'qvac.sync'
    readonly protocolVersion: 1
    readonly hosts: readonly string[]
  }
  readonly bundlePath: string
  readonly metadata: SyncBuildMetadata
}

export interface SyncContribution {
  readonly schemaVersion: 1
  readonly packageName: '@qvac/sync'
  readonly packageVersion: string
  readonly contract: 'qvac.sync'
  readonly protocolVersion: 1
  readonly bundleId: string
  readonly hosts: readonly string[]
  readonly nativeAddons: readonly NativeAddonIdentity[]
  readonly packages: readonly PackageIdentity[]
  readonly harnessPath: string
  readonly metadataPath: string
  readonly bundlePath: string
}

export interface ComposeSyncContributionOptions {
  readonly packageVersion?: string
}

export interface CreateSyncExpoPluginOptions extends ComposeSyncContributionOptions {
  readonly mode?: 'standalone' | 'contributor'
  readonly build?: () => Promise<SyncBuildResult>
}
