import type { ConfigPlugin } from '@expo/config-plugins'
import type { ExecutionRealm, PackageInstance } from '../artifact-validation.ts'

export const ASSISTANT_STACK_MANIFEST_VERSION = 3
export const ASSISTANT_MANIFEST_PROVENANCE_VERSION = 1
export const WORKER_ADAPTER_VERSION = 1

export const PLUGIN_EXECUTION_ORDER = Object.freeze([
  'sync-contributor-plugin',
  'harness-contributor-plugin',
  'invoke-sdk-expo-plugin',
  'finalize-assistant-stack'
] as const)

export const SDK_PLUGIN_ID = '@qvac/sdk/expo-plugin'
export const SYNC_PLUGIN_ID = '@qvac/sync/expo-plugin'
export const HARNESS_PLUGIN_ID = '@qvac/harness/expo-plugin'
export const ASSISTANT_PLUGIN_ID = '@qvac/assistant/expo-plugin'
export const ASSISTANT_FINALIZE_RUN_ONCE = '@qvac/assistant/expo-plugin/finalize'

export const REQUIRED_MOBILE_HOSTS = Object.freeze([
  'android-arm64',
  'ios-arm64',
  'ios-arm64-simulator',
  'ios-x64-simulator'
] as const)

export interface AssistantAddon {
  readonly name: string
  readonly version: string
}

export interface PackageIdentity {
  readonly name: string
  readonly version: string
  readonly packagePath: string
  readonly singleton: boolean
}

export interface PackageContribution {
  readonly schemaVersion: number
  readonly packageName: string
  readonly packageVersion: string
  readonly contract: string
  readonly protocolVersion: number
  readonly bundleId: string
  readonly hosts: readonly string[]
  readonly nativeAddons: readonly AssistantAddon[]
  readonly packages: readonly PackageIdentity[]
  readonly harnessPath: string
  readonly metadataPath: string
  readonly bundlePath: string
}

export interface SdkAddonsManifest {
  readonly version: number
  readonly bundleId: string | null
  readonly addons: readonly string[]
  readonly assistantProvenance?: AssistantManifestProvenance
}

export interface AssistantManifestProvenance {
  readonly schemaVersion: number
  readonly sourcePlugin: string
  readonly sourcePluginVersion: string
  readonly sdkSourceAddons: readonly AssistantAddon[]
}

export interface WorkerAddonInventory {
  readonly role: 'sync' | 'harness'
  readonly contract: string
  readonly protocolVersion: number
  readonly bundleId: string
  readonly hosts: readonly string[]
  readonly nativeAddons: readonly AssistantAddon[]
  readonly packages: readonly PackageInstance[]
}

export interface BuiltWorkerArtifacts {
  readonly sync: WorkerAddonInventory
  readonly harness: WorkerAddonInventory
}

export interface AssistantStackManifest {
  readonly manifestVersion: number
  readonly pluginExecutionOrder: readonly string[]
  readonly requiredHosts: readonly string[]
  readonly packageVersions: {
    readonly assistant: string
    readonly sync: string
    readonly harness: string
    readonly sdk: string
  }
  readonly bundles: {
    readonly sync: string
    readonly harness: string
    readonly sdk: string | null
  }
  readonly sdkSource: {
    readonly manifestVersion: number
    readonly bundleId: string | null
    readonly addons: readonly AssistantAddon[]
  }
  readonly workers: {
    readonly sync: {
      readonly contract: string
      readonly protocolVersion: number
      readonly hosts: readonly string[]
      readonly nativeAddons: readonly AssistantAddon[]
    }
    readonly harness: {
      readonly contract: string
      readonly protocolVersion: number
      readonly hosts: readonly string[]
      readonly nativeAddons: readonly AssistantAddon[]
    }
  }
  readonly mergedAddons: readonly AssistantAddon[]
  readonly realms: readonly ExecutionRealm[]
  readonly singletonPackages: readonly string[]
}

export interface CreateAssistantExpoPluginOptions {
  readonly sdkPlugin?: ConfigPlugin
  readonly syncPlugin?: ConfigPlugin
  readonly harnessPlugin?: ConfigPlugin
  readonly syncBuild?: () => Promise<unknown>
  readonly harnessBuild?: () => Promise<unknown>
}

export interface ComposeAssistantStackOptions {
  readonly projectRoot: string
  readonly pinLinkerRoot?: boolean
  readonly syncContribution?: PackageContribution
  readonly harnessContribution?: PackageContribution
}

export interface FinalizeAssistantStackOptions {
  readonly pinLinkerRoot?: boolean
  readonly syncContribution?: PackageContribution
  readonly harnessContribution?: PackageContribution
}
