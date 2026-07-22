/**
 * Text chunking for sentence-stream TTS. Intl.Segmenter is used when present;
 * Bare runtimes without it fall back to punctuation and max-length splitting.
 */
export interface SplitTtsTextOptions {
    language?: string;
    locale?: string;
    maxScalars?: number;
    mergeToMaxScalars?: boolean;
}
export declare function intlSentenceSegmentationAvailable(): boolean;
export declare function splitByIntlSentences(text: string, locale?: string): string[] | null;
export declare function splitByAsciiAndCjkPunctuation(text: string): string[];
export declare function countScalars(value: string): number;
export declare const KOREAN_MAX_CHUNK_SCALARS = 120;
export declare const DEFAULT_MAX_CHUNK_SCALARS = 300;
export declare function defaultMaxChunkScalars(language?: string): number;
export declare function splitTtsText(text: string, options?: SplitTtsTextOptions): string[];
