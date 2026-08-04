/**
 * Bergamot Model Fetcher
 *
 * Downloads Bergamot (Firefox Translations) model files from the
 * Firefox Remote Settings CDN — the same source Firefox browser uses.
 *
 * This module does NOT touch OPUS or IndicTrans models.
 */
/** Filenames expected for a Bergamot language pair. */
export interface BergamotFileNames {
    modelName: string;
    srcVocabName: string;
    dstVocabName: string;
    lexName: string;
}
export declare function normalizeBcp47Lang(lang: string): string;
/**
 * Returns expected Bergamot model filenames for a language pair.
 * CJK target languages (zh, ja, ko) use separate src/trg vocabs.
 */
export declare function getBergamotFileNames(srcLang: string, dstLang: string): BergamotFileNames;
/**
 * Checks whether a directory already contains a valid Bergamot model
 * (at minimum an .intgemm model file and a .spm vocab file).
 */
export declare function hasBergamotModelFiles(dir: string): boolean;
/**
 * Downloads Bergamot model files from Mozilla's Firefox Remote Settings CDN.
 * This is the same source Firefox itself uses for translation models.
 */
export declare function downloadBergamotFromFirefox(srcLang: string, dstLang: string, destDir: string): Promise<string>;
/**
 * Ensures Bergamot model files are present in destDir for a given language pair.
 *
 *   1. If model files already exist in destDir → returns immediately
 *   2. Downloads from Firefox Remote Settings CDN
 *
 * @param srcLang  Source language code (e.g. 'en')
 * @param dstLang  Target language code (e.g. 'it')
 * @param destDir  Directory to store model files
 * @returns Resolved path to the model directory
 */
export declare function ensureBergamotModelFiles(srcLang: string, dstLang: string, destDir: string): Promise<string>;
