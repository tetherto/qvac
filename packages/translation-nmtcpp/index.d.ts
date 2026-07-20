import QvacLogger = require("@qvac/logging");
import { QvacResponse } from "@qvac/infer-base";
export interface TranslationNmtcppFiles {
    model: string;
    srcVocab?: string;
    dstVocab?: string;
    pivotModel?: string;
    pivotSrcVocab?: string;
    pivotDstVocab?: string;
}
export interface TranslationNmtcppParams {
    dstLang: string;
    srcLang: string;
    [key: string]: unknown;
}
export interface TranslationNmtcppArgs {
    files: TranslationNmtcppFiles;
    params: TranslationNmtcppParams;
    config?: TranslationNmtcppConfig;
    logger?: unknown;
    opts?: {
        stats?: boolean;
    };
    [key: string]: unknown;
}
export interface TranslationNmtcppModelTypes {
    readonly IndicTrans: "IndicTrans";
    readonly Bergamot: "Bergamot";
}
export interface TranslationNmtcppConfig {
    modelType: TranslationNmtcppModelTypes[keyof TranslationNmtcppModelTypes];
    pivotConfig?: Record<string, unknown>;
    /**
     * Enable GPU (non-CPU) compute backend. Read once at load() time.
     * Bergamot is CPU-only by design — this flag is a no-op for that backend.
     *
     * `use_gpu` mirrors the C-struct field (`nmt_context_params::use_gpu`)
     * and is the primary key. `useGPU` is the camelCase alias matching the
     * `ocr-onnx` convention (caps acronym). Both forms are accepted; if
     * both are set, `use_gpu` takes precedence.
     * @default false
     */
    use_gpu?: boolean;
    useGPU?: boolean;
    /**
     * Case-insensitive substring filter over the ggml device name when selecting
     * a compute backend (e.g. "vulkan", "vulkan0", "opencl", "metal"). When set,
     * replaces the default gated selector with a single explicit pass.
     * An explicit "opencl" bypasses the build-time USE_OPENCL guard.
     *
     * `gpu_backend` mirrors the C-struct field and is the primary key.
     * `gpuBackend` is the camelCase alias matching the `ocr-onnx` convention.
     * Both forms are accepted; if both are set, `gpu_backend` takes precedence.
     */
    gpu_backend?: string;
    gpuBackend?: string;
    /**
     * Ordinal within the matching compute devices. Defaults to 0.
     * Example: { gpu_backend: "vulkan", gpu_device: 1 } → second Vulkan adapter.
     *
     * `gpu_device` mirrors the C struct and is the primary key.
     * `gpuDevice` is the camelCase alias.
     * If both are set, `gpu_device` takes precedence.
     */
    gpu_device?: number;
    gpuDevice?: number;
    /**
     * Path to the directory containing backend shared libraries
     * (libqvac-ggml-vulkan.so, etc.). Defaults to `<package>/prebuilds` — where
     * npm install places the shipped prebuilds.
     */
    backendsDir?: string;
    /**
     * Android-only. Writable directory for the OpenCL JIT kernel cache.
     * Forwarded to the backend via GGML_OPENCL_CACHE_DIR. Always provide an
     * app-writable path when exercising OpenCL on Android.
     */
    openclCacheDir?: string;
    [key: string]: unknown;
}
export interface InferenceClientState {
    configLoaded: boolean;
    weightsLoaded: boolean;
    destroyed: boolean;
}
/**
 * Stats returned via `response.stats` when the addon is constructed with
 * `opts.stats = true`. Field set differs by backend:
 *
 * - Bergamot emits: `totalTokens`, `totalTime`, `decodeTime`, `TPS`.
 * - GGML/IndicTrans emits the above plus `encodeTime` and `TTFT`.
 *
 * Units:
 * - `totalTime`, `encodeTime`, `decodeTime` — seconds (double).
 * - `TTFT` (Time-To-First-Token) — milliseconds (double).
 * - `TPS` (Tokens-Per-Second) — tokens / second (double).
 * - `totalTokens` — integer count.
 *
 * Note: pivot translations may emit keys prefixed with the model name
 * (e.g. `"BERGAMOT : ->TPS"`). This interface models the non-pivot shape.
 */
export interface RuntimeStats {
    totalTokens: number;
    totalTime: number;
    decodeTime: number;
    TPS: number;
    encodeTime?: number;
    TTFT?: number;
}
/**
 * TranslationNmtcpp implementation for Marian/IndicTrans/Bergamot translation models
 */
export default class TranslationNmtcpp {
    /**
     * Available model types for translation
     */
    static readonly ModelTypes: TranslationNmtcppModelTypes;
    private readonly opts;
    readonly logger: QvacLogger;
    private addon;
    private state;
    private readonly _modelType;
    private readonly _files;
    private readonly _config;
    private readonly _params;
    private readonly _pivotConfig;
    private readonly _job;
    private readonly _run;
    /**
     * Creates an instance of TranslationNmtcpp.
     */
    constructor({ files, params, config, logger, opts, }: TranslationNmtcppArgs);
    /**
     * Returns the current state of the inference client.
     */
    getState(): InferenceClientState;
    /**
     * Loads the model. If already loaded, unloads first.
     */
    load(): Promise<void>;
    /**
     * Runs inference on the given input. Serialized — only one job at a time.
     * @param input - Text to translate
     */
    run(input: string): Promise<QvacResponse<string>>;
    /**
     * Unloads the model and frees resources.
     */
    unload(): Promise<void>;
    /**
     * Destroys the model permanently.
     */
    destroy(): Promise<void>;
    /**
     * Returns the name of the currently-loaded non-CPU backend (e.g. 'Vulkan0',
     * 'OpenCL', 'Metal'), or a sentinel:
     *   - 'Unloaded'     — model is not loaded
     *   - 'Bergamot-CPU' — Bergamot model (CPU-only by design)
     *   - 'CPU'          — GGML backend loaded, only CPU backend registered
     */
    getActiveBackendName(): "Unloaded" | "Bergamot-CPU" | "CPU" | (string & {});
    /**
     * Returns the human-readable device description for the active GPU backend
     * (e.g. 'NVIDIA GeForce RTX 5070', 'Intel(R) UHD Graphics').
     * Returns '' when no GPU backend is loaded or model is unloaded.
     */
    getActiveBackendDescription(): string;
    /**
     * Checks if this is a Bergamot model
     */
    private _isBergamotModel;
    /**
     * Configures Bergamot-specific parameters
     */
    private _configureBergamotModel;
    private _load;
    /**
     * Handles IndicTrans model translation
     */
    private _runIndicTrans;
    /**
     * Prepares input text with language prefix if needed
     */
    private _prepareInputText;
    /**
     * Creates a response with output post-processing for language prefixes
     */
    private _createStandardResponse;
    /**
     * Handles standard model translation (Bergamot)
     */
    private _runStandardTranslation;
    private _runInternal;
    /**
     * Translates multiple texts in a single batch for better performance.
     *
     * @param texts - Array of texts to translate
     * @returns Array of translated texts (same order as input)
     */
    runBatch(texts: string[]): Promise<string[]>;
    private _addonOutputCallback;
}
