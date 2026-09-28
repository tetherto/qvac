export declare const PREBUILT_HOSTS: string[]

export interface BackendsDirSources {
  host: string | null
  resolveLocalAddon: () => string | null
  resolveManifest: (specifier: string) => string | null
}

export declare function hostPlatformPackage (host: string): string
export declare function resolveBackendsDirFrom (sources: BackendsDirSources): string | null
export declare function resolveBackendsDir (): string | null
