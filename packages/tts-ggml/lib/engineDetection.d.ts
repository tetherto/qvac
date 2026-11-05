import { type EngineType } from "./engineIds";
import type { ModelPaths } from "./engineSetup";
import { type NormalizedFiles } from "./modelFiles";
export declare function detectEngineType(engine: EngineType | undefined, files: NormalizedFiles): EngineType;
/** The constructor options that name dictionary files directly. */
export interface ModelPathOptions {
    mecabDictPath?: string;
    mecabDictDir?: string;
    cangjieTsvPath?: string;
    /** MOSS dialogue mode, which narrows the backbone discovered under `modelDir`. */
    dialogue: boolean;
}
/** The model files `engineType` loads: explicit paths first, then `modelDir`. */
export declare function resolveModelPaths(engineType: EngineType, files: NormalizedFiles, options: ModelPathOptions): ModelPaths;
