import type { TTSConfigurationParams } from "../../tts";
import type { EngineSetup, ModelPaths } from "../engineSetup";
import { type NormalizedFiles } from "../modelFiles";
export declare const CHATTERBOX_T3_TURBO = "chatterbox-t3-turbo.gguf";
export declare const CHATTERBOX_T3_MTL = "chatterbox-t3-mtl.gguf";
export declare const CHATTERBOX_S3GEN_DEFAULT = "chatterbox-s3gen.gguf";
export declare const CHATTERBOX_S3GEN_MTL = "chatterbox-s3gen-mtl.gguf";
/** True when `modelDir` holds a Chatterbox T3 GGUF (Turbo or multilingual). */
export declare function hasChatterboxModelDir(modelDir: string): boolean;
/** Explicit T3 / S3Gen paths win over the pair discovered under `modelDir`. */
export declare function resolveChatterboxModelPaths(files: NormalizedFiles): Pick<ModelPaths, "t3ModelPath" | "s3genModelPath">;
export declare function buildChatterboxParams(setup: EngineSetup): TTSConfigurationParams;
