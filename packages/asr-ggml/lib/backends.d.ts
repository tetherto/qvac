export declare const PREBUILT_HOSTS: string[];
export interface BackendsDirSources {
    localPrebuildsDir: string;
    host: string | null;
    directoryExists: (dir: string) => boolean;
    resolveManifest: (specifier: string) => string | null;
}
export declare function hostPlatformPackage(host: string): string;
export declare function resolveBackendsDirFrom(sources: BackendsDirSources): string;
export declare function resolveBackendsDir(): string;
