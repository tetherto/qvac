/** The interchangeable DiT stage; the other three stages are fixed. */
export type DitVariant = 'turbo-q4' | 'turbo-q8' | 'sft';
/** The four ACE-Step stage paths/filenames for a given DiT variant. */
export interface ModelManifest {
    textEnc: string;
    lm: string;
    dit: string;
    vae: string;
}
/** Registry "*Src" object shaped for the SDK plugin's resolveConfig. */
export interface ModelSources {
    textEncModelSrc: string;
    lmModelSrc: string;
    ditModelSrc: string;
    vaeModelSrc: string;
}
export interface ResolveDitModelPathOptions {
    modelDir?: string;
    ditModel?: string;
    ditVariant?: DitVariant;
}
/** Source name for the model registry (the `source` arg of downloadModel/getModel). */
export declare const REGISTRY_SOURCE = "s3";
export declare const REGISTRY_PREFIX = "qvac_models_compiled/ggml/acestep/2026-07-22";
export declare const FIXED_MODELS: {
    readonly textEnc: "Qwen3-Embedding-0.6B-Q8_0.gguf";
    readonly lm: "acestep-5Hz-lm-0.6B-Q8_0.gguf";
    readonly vae: "vae-BF16.gguf";
};
export declare const DIT_VARIANTS: Record<DitVariant, string>;
export declare const DEFAULT_DIT_VARIANT: DitVariant;
export declare function ditVariants(): DitVariant[];
export declare function registryPath(filename: string): string;
export declare function ditFilename(variant?: DitVariant): string;
export declare function modelFilenames(variant?: DitVariant): ModelManifest;
export declare function modelManifest(variant?: DitVariant): ModelManifest;
export declare function modelSources(variant?: DitVariant): ModelSources;
export declare function resolveDitModelPath({ modelDir, ditModel, ditVariant }?: ResolveDitModelPathOptions): string | undefined;
export declare function allRegistryPaths(): string[];
