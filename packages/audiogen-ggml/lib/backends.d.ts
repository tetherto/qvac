export interface BackendsDirSources {
  localPrebuildsDir: string
  host: string | null
  directoryExists: (dir: string) => boolean
  resolveManifest: (specifier: string) => string | null
}

export const PREBUILT_HOSTS: string[]
export function hostPlatformPackage(host: string): string
export function resolveBackendsDirFrom(sources: BackendsDirSources): string
export function resolveBackendsDir(): string
