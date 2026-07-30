import { type TranslationLogger } from "./lib/log-forward";
/** Configuration object handed to the native addon at instance creation. */
export interface TranslationConfigurationParams {
    path: string;
    config: Record<string, unknown>;
}
/** Job payload submitted to the native runner. */
export interface TranslationJob {
    type: string;
    input: string | string[];
}
/** Callback invoked for every native inference event. */
export type TranslationOutputCallback = (addon: unknown, event: string, data: unknown, error: unknown) => void;
export type { TranslationLogger } from "./lib/log-forward";
type NativeLoggerCallback = (priority: number, message: string) => void;
/** Native binding surface consumed by {@link TranslationInterface}. */
export interface TranslationBinding {
    createInstance(owner: TranslationInterface, configurationParams: TranslationConfigurationParams, outputCb: TranslationOutputCallback): object;
    setLogger(callback: NativeLoggerCallback): void;
    releaseLogger(): void;
    loadWeights(handle: object, weightsData: unknown): void;
    activate(handle: object): void;
    cancel(handle: object): Promise<void>;
    getActiveBackendName(handle: object): string;
    getActiveBackendDescription(handle: object): string;
    runJob(handle: object, data: TranslationJob): boolean;
    destroyInstance(handle: object): void;
}
/**
 * An interface between Bare addon in C++ and JS runtime.
 */
export declare class TranslationInterface {
    private _handle;
    private _loggerInitialized;
    /**
     * @param configurationParams - all the required configuration for inference setup
     * @param outputCb - to be called on any inference event ( started, new output, error, etc )
     * @param transitionCb - to be called on addon state changes (LISTENING, IDLE, STOPPED, etc )
     */
    constructor(configurationParams: TranslationConfigurationParams, outputCb: TranslationOutputCallback, transitionCb?: TranslationLogger | null);
    destroyInstance(): Promise<void>;
    /**
     * Stops addon process and clears resources (including memory).
     */
    unload(): Promise<void>;
    /**
     * Loads weights for the model.
     * Can only be invoked after instance is constructed or after load()/reload() are called
     * @param weightsData
     * @param weightsData.filename
     * @param weightsData.contents
     * @param weightsData.completed
     */
    loadWeights(weightsData: unknown): Promise<void>;
    /**
     * Moves addon to the LISTENING state after all the initialization is done
     */
    activate(): Promise<void>;
    /**
     * Cancel a inference process
     */
    cancel(): Promise<void>;
    /**
     * Returns the name of the currently-loaded non-CPU backend (e.g. 'Vulkan0',
     * 'OpenCL', 'Metal'), or a sentinel string:
     *   - 'Unloaded'     — model is not loaded
     *   - 'Bergamot-CPU' — Bergamot model (CPU-only by design)
     *   - 'CPU'          — GGML backend loaded, only CPU backend registered
     *
     * Synchronous by design: reads cached state populated at load() time.
     * @returns {string}
     */
    getActiveBackendName(): string;
    /**
     * Returns the human-readable device description for the active GPU backend
     * (e.g. 'NVIDIA GeForce RTX 5070', 'Intel(R) UHD Graphics').
     * Returns '' when no GPU backend is loaded or model is unloaded.
     *
     * Silently catches native errors — the description is informational and
     * callers should not fail when the backend cannot provide one. This
     * intentionally diverges from the error-throwing pattern used by other
     * binding wrappers in this class.
     * @returns {string}
     */
    getActiveBackendDescription(): string;
    /**
     * Submits a job to the processing pipeline
     * @param data
     * @param data.type - 'text' for single input, 'sequences' for batch
     * @param data.input
     * @returns {boolean} true if job was accepted
     */
    runJob(data: TranslationJob): Promise<boolean>;
    /**
     * Stops addon process and clears resources (including memory).
     */
    destroy(): Promise<void>;
}
