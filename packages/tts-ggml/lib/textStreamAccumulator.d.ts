export declare const DEFAULT_FLUSH_AFTER_MS = 500;
export type SentenceDelimiterPreset = "latin" | "cjk" | "multilingual";
export interface TextStreamAccumulatorOptions {
    sentenceDelimiter?: RegExp;
    sentenceDelimiterPreset?: SentenceDelimiterPreset;
    maxBufferScalars?: number;
    flushAfterMs?: number;
    language?: string;
}
export declare function splitGraphemeHead(value: string, count: number): {
    head: string;
    rest: string;
};
export declare function buildSentenceEndTester(options: Pick<TextStreamAccumulatorOptions, "sentenceDelimiter" | "sentenceDelimiterPreset">): (buffer: string) => boolean;
export declare function defaultMaxBufferScalars(language?: string): number;
export declare function accumulateTextStream(source: AsyncIterable<string>, options?: TextStreamAccumulatorOptions): AsyncGenerator<string, void, void>;
