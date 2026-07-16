import { type BCIConfigurationParams } from "./configChecker";
export declare const END_OF_INPUT = "end of job";
export declare const MAX_BUFFERED_BYTES: number;
export declare function nextSafeId(current: number): number;
/** Concatenate a list of byte chunks into a single contiguous Uint8Array. */
export declare function concatChunks(chunks: Uint8Array[]): Uint8Array;
/** Neural signal job payload handed to the native runner. */
export interface NeuralJob {
    type: "neural";
    input: Uint8Array;
}
/** Data appended to the internal buffer, or an end-of-job marker. */
export interface AppendData {
    type: string;
    input?: Uint8Array;
}
/** Low-level callback invoked once per normalized native event. */
export type BCIJobEventCallback = (addon: unknown, event: string, jobId: number, data: unknown, error: unknown) => void;
/** Callback invoked on every internal state transition. */
export type TransitionCallback = (addon: BCIInterface, newState: string) => void;
/** Raw callback the native addon invokes with un-normalized events. */
export type NativeOutputCallback = (addon: unknown, event: unknown, data: unknown, error: unknown) => void;
/** Native binding surface used by {@link BCIInterface}. */
export interface BCIBinding {
    createInstance(owner: BCIInterface, configurationParams: BCIConfigurationParams, outputCallback: NativeOutputCallback, transitionCb: TransitionCallback | null): object;
    activate(handle: unknown): void;
    cancel(handle: unknown, jobId?: number): Promise<void>;
    runJob(handle: unknown, input: NeuralJob): boolean;
    destroyInstance(handle: unknown): void;
    reload?(handle: unknown, configurationParams: BCIConfigurationParams): Promise<void>;
    loadWeights(handle: unknown, weightsData: unknown): void;
}
/**
 * Low-level interface between the Bare C++ BCI addon and the JS runtime.
 * Accepts neural signal data (Uint8Array) instead of audio.
 */
export declare class BCIInterface {
    static readonly END_OF_INPUT = "end of job";
    private readonly _binding;
    private readonly _outputCb;
    private readonly _transitionCb;
    private _nextJobId;
    private _activeJobId;
    private _bufferedSignal;
    private _bufferedBytes;
    private _state;
    private _handle;
    constructor(binding: BCIBinding, configurationParams: BCIConfigurationParams, outputCb: BCIJobEventCallback, transitionCb?: TransitionCallback | null);
    private _setState;
    private _addonOutputCallback;
    unload(): Promise<void>;
    load(configurationParams: BCIConfigurationParams): Promise<void>;
    reload(configurationParams: BCIConfigurationParams): Promise<void>;
    loadWeights(weightsData: unknown): Promise<void>;
    unloadWeights(): Promise<boolean>;
    activate(): Promise<void>;
    cancel(jobId?: number): Promise<void>;
    /**
     * Appends neural signal data to the processing buffer.
     * Send { type: 'end of job' } to trigger processing.
     * @returns job ID
     */
    append(data: AppendData): Promise<number>;
    private _appendSync;
    /**
     * Run a single batch job directly with neural signal data.
     */
    runJob(data: {
        input?: unknown;
    }): Promise<boolean>;
    status(): Promise<string>;
    destroyInstance(): Promise<void>;
    private _concatBufferedSignal;
}
