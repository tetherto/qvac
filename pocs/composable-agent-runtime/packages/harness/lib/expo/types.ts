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

export interface HarnessBuildMetadata {
  readonly bundleId: string | null
  readonly contract: string
  readonly protocolVersion: number
  readonly hosts: readonly string[]
  readonly nativeAddons: readonly string[]
  readonly packages?: readonly PackageIdentity[]
}

export interface HarnessBuildResult {
  readonly descriptor: {
    readonly entryPath: string
    readonly harnessPath: string
    readonly metadataPath: string
    readonly contract: 'qvac.harness'
    readonly protocolVersion: 1
    readonly hosts: readonly string[]
  }
  readonly bundlePath: string
  readonly metadata: HarnessBuildMetadata
}

export interface HarnessContribution {
  readonly schemaVersion: 1
  readonly packageName: '@qvac/harness'
  readonly packageVersion: string
  readonly contract: 'qvac.harness'
  readonly protocolVersion: 1
  readonly bundleId: string
  readonly hosts: readonly string[]
  readonly nativeAddons: readonly NativeAddonIdentity[]
  readonly packages: readonly PackageIdentity[]
  readonly harnessPath: string
  readonly metadataPath: string
  readonly bundlePath: string
}

export interface ComposeHarnessContributionOptions {
  readonly packageVersion?: string
}

export interface CreateHarnessExpoPluginOptions extends ComposeHarnessContributionOptions {
  readonly mode?: 'standalone' | 'contributor'
  readonly build?: () => Promise<HarnessBuildResult>
}
