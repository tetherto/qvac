import type { RuntimeConfig } from './protocol';
export * from './protocol';
export * from './worker-manager';
export interface MiniMaxDiffusersOptions {
    modelDir: string;
    cacheDir?: string;
    pythonPath?: string;
}
export declare function resolveRuntimeConfig(options: MiniMaxDiffusersOptions): RuntimeConfig;
