/**
 * IndicTrans Model Fetcher
 *
 * Downloads IndicTrans2 GGML model files from the QVAC model registry.
 *
 * This module does NOT touch Bergamot or OPUS models.
 */
interface IndicTransModelInfo {
    registryPath: string;
    registrySource: string;
    filename: string;
    expectedMinSizeMB: number;
}
export declare const INDICTRANS_MODELS: Record<string, IndicTransModelInfo>;
/**
 * Downloads an IndicTrans model file from the QVAC model registry.
 */
export declare function downloadIndicTransFromRegistry(modelKey: string, destPath: string): Promise<string>;
/**
 * Ensures an IndicTrans model file is present at destPath.
 *
 *   1. If a valid model file already exists → returns immediately
 *   2. Downloads from QVAC model registry
 *
 * @param destPath  Full path where the model file should be stored
 * @param modelKey  Model variant key
 * @returns Resolved path to the model file
 */
export declare function ensureIndicTransModelFile(destPath: string, modelKey?: string): Promise<string>;
/**
 * Returns the default filename for an IndicTrans model variant.
 *
 * @param modelKey  Model variant key
 * @returns Filename
 */
export declare function getIndicTransFileName(modelKey?: string): string;
export {};
