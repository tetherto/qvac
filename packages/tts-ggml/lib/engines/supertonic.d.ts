import type { TTSConfigurationParams } from "../../tts";
import type { EngineSetup, ModelPaths } from "../engineSetup";
import { type NormalizedFiles } from "../modelFiles";
export declare const SUPERTONIC_DEFAULT = "supertonic.gguf";
export declare const SUPERTONIC_MTL = "supertonic2.gguf";
export declare const SUPERTONIC_V3_RE: RegExp;
export declare const SUPERTONIC_V3_QUANT_ORDER: string[];
export declare function findSupertonicV3InDir(modelDir?: string): string | undefined;
/** True when `modelDir` holds any Supertonic GGUF (v1, v2 or v3). */
export declare function hasSupertonicModelDir(modelDir: string): boolean;
/** An explicit path wins over the GGUF discovered under `modelDir`. */
export declare function resolveSupertonicModelPaths(files: NormalizedFiles): Pick<ModelPaths, "supertonicModelPath">;
export declare function buildSupertonicParams(setup: EngineSetup): TTSConfigurationParams;
