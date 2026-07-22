type NativeLoggerCallback = (priority: number, message: string) => void;
/**
 * Logger object forwarded to the native `setLogger` bridge. Any subset of the
 * four level methods may be provided; each receives a formatted C++ log line.
 */
export interface TransitionLogger {
    error?: (message: string) => void;
    warn?: (message: string) => void;
    info?: (message: string) => void;
    debug?: (message: string) => void;
}
/**
 * Backend device the C++ pipeline resolved for inference, as reported by the
 * native `getBackendInfo` binding.
 */
export interface BackendInfo {
    /** Requested device (`'cpu'` | `'vulkan'` | `'metal'` | `'opencl'`). */
    requested: string;
    /** Resolved device type (`'CPU'` | `'GPU'` | `'IGPU'` | `'ACCEL'`). */
    backendDevice: string;
    /** ggml backend/device name of the resolved device (e.g. `'Vulkan0'`, `'CPU'`). */
    backendName: string;
    /**
     * ggml device index of the selected device (the index into the loaded ggml
     * devices), or `-1` when the CPU backend was selected (including fallback).
     */
    deviceIndex: number;
    /** Human-readable device description (e.g. `'NVIDIA GeForce RTX 4090'`, `'Apple M3'`); empty when ggml provides none. */
    backendDescription: string;
    /** Empty when the requested device was used; otherwise why it fell back to CPU. */
    fallbackReason: string;
}
/** Configuration object passed through to the native OCR addon. */
export interface OcrGgmlConfigurationParams {
    pathDetector: string;
    pathRecognizer: string;
    langList: string[];
    backendsDir?: string;
    [key: string]: unknown;
}
/** Options accepted by a single OCR run. */
export interface OcrGgmlRunOptions {
    paragraph?: boolean;
    boxMarginMultiplier?: number;
    rotationAngles?: number[];
}
/** OCR inference job payload handed to the native runner. */
export interface OcrGgmlJob {
    type: "image";
    input: {
        data: Buffer;
        isEncoded?: boolean;
        width?: number;
        height?: number;
        bitsPerPixel?: number;
    };
    options?: OcrGgmlRunOptions;
}
/** Raw callback the native addon invokes with inference events. */
export type OcrGgmlOutputCallback = (addon: unknown, event: unknown, data: unknown, error: unknown) => void;
/** Native binding surface used by {@link OcrGgmlInterface}. */
export interface OcrGgmlBinding {
    createInstance(owner: OcrGgmlInterface, configurationParams: OcrGgmlConfigurationParams, outputCb: OcrGgmlOutputCallback): object;
    setLogger(callback: NativeLoggerCallback): void;
    releaseLogger(): void;
    activate(handle: unknown): void;
    cancel(handle: unknown): Promise<void>;
    runJob(handle: unknown, data: OcrGgmlJob): Promise<boolean>;
    getBackendInfo(handle: unknown): BackendInfo;
    destroyInstance(handle: unknown): void;
}
/**
 * Thin wrapper around the C++ bare addon. Mirrors the surface of
 * `translation-nmtcpp`'s `marian.js` / `ocr-onnx`'s `ocr-fasttext.js`.
 */
export declare class OcrGgmlInterface {
    private _binding;
    private _handle;
    private _loggerInitialized;
    /**
     * @param configurationParams - configuration for inference setup
     * @param outputCb - invoked on inference events (output, error, stats)
     * @param transitionCb - optional logger object with `info`/`warn`/`error`/`debug`
     *   methods. When provided, C++ log lines are forwarded via `binding.setLogger`.
     */
    constructor(binding: OcrGgmlBinding, configurationParams: OcrGgmlConfigurationParams, outputCb: OcrGgmlOutputCallback, transitionCb?: TransitionLogger | null);
    destroyInstance(): Promise<void>;
    unload(): Promise<void>;
    /**
     * Moves the addon to LISTENING after construction-time work is finished.
     */
    activate(): Promise<void>;
    cancel(): Promise<void>;
    /**
     * Submit an OCR inference job.
     * @param data.type - `'image'`
     * @param data.input - either `{ data, isEncoded: true }` for a raw JPEG/PNG
     *   buffer, or `{ data, width, height }` for raw RGB pixels.
     * @param data.options - optional per-run overrides.
     */
    runJob(data: OcrGgmlJob): Promise<boolean>;
    /**
     * Returns the backend device the C++ pipeline resolved for inference.
     */
    getBackendInfo(): BackendInfo | null;
    destroy(): Promise<void>;
}
export {};
