export interface AddonLogger {
    error?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
}
export interface LlmSglangBinding {
    createInstance(owner: LlmSglangInterface, configurationParams: {
        baseUrl: string;
        apiKey?: string;
    }, outputCallback: LlmSglangOutputCallback): object;
    activate(handle: unknown): void;
    runJob(handle: unknown, input: SglangJob): Promise<boolean> | boolean;
    cancel(handle: unknown): Promise<void> | void;
    destroyInstance(handle: unknown): void;
}
export interface SglangJob {
    messages: unknown[];
    generationParams?: Record<string, unknown>;
}
export type LlmSglangOutputCallback = (addon: LlmSglangInterface, event: unknown, data: unknown, error: unknown) => void;
export type MappedAddonEvent = {
    type: 'Output' | 'Error' | 'JobEnded';
    data: unknown;
    error: unknown;
};
/**
 * Normalize a native event into Output, Error, or JobEnded. String payloads
 * are token deltas. A plain object is the terminal runtime-stats snapshot.
 */
export declare function mapAddonEvent(rawEvent: unknown, rawData: unknown, rawError: unknown): MappedAddonEvent | null;
export declare class LlmSglangInterface {
    private readonly binding;
    private handle;
    constructor(binding: LlmSglangBinding, configurationParams: {
        baseUrl: string;
        apiKey?: string;
    }, outputCallback: LlmSglangOutputCallback);
    activate(): Promise<void>;
    runJob(input: SglangJob): Promise<boolean>;
    cancel(): Promise<void>;
    unload(): Promise<void>;
}
