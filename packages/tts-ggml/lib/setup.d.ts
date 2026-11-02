import type { EngineSetup } from "./engineSetup";
import type { TTSGgmlOptions } from "./types";
export declare function resolveDefaultLazySessionLoading(lazySessionLoading?: boolean): boolean;
export declare function validateOutputSampleRate(outputSampleRate?: number): number | null;
export declare function assertGpuIntentConsistent(useGPU?: boolean, nGpuLayers?: number): void;
/** Resolve and validate everything the constructor derives from `options`. */
export declare function resolveEngineSetup(options: TTSGgmlOptions): EngineSetup;
