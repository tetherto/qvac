import QvacLogger = require("@qvac/logging");
import { type QvacResponse } from "@qvac/infer-base";
import { OcrGgmlInterface, type BackendInfo, type OcrGgmlRunOptions } from "./ocr-ggml";
import { QvacErrorAddonOcrGgml, ERR_CODES } from "./lib/error";
/**
 * OCR pipeline backing the addon.
 *   - `easyocr` (default): CRAFT detector + CRNN gen-2 recognizer.
 *     Uses `langList`, `magRatio`, `defaultRotationAngles`, `contrastRetry`,
 *     `lowConfidenceThreshold`, `recognizerBatchSize`.
 *   - `doctr`: DBNet detector + doctr recognizer.
 *     Language-agnostic; EasyOCR-specific knobs (`magRatio`, etc.) are
 *     ignored.
 */
export type OcrGgmlPipelineType = "easyocr" | "doctr";
export interface OcrGgmlParams {
    /**
     * Path to the detector GGUF file.
     *   - easyocr: CRAFT model (e.g. `craft_mlt_25k.gguf`)
     *   - doctr:   DBNet model (e.g. `db_mobilenet_v3_large.gguf`)
     */
    pathDetector: string;
    /**
     * Path to the recognizer GGUF file.
     *   - easyocr: CRNN gen-2 (e.g. `english_g2.gguf`, `latin_g2.gguf`)
     *   - doctr:   doctr recognition model (e.g. `crnn_mobilenet_v3_small.gguf`)
     */
    pathRecognizer: string;
    /** Languages handled by the recognizer (e.g. `['en']`, `['en', 'fr']`). */
    langList: string[];
    /** Pipeline backing the addon. Default: `'easyocr'`. */
    pipelineType?: OcrGgmlPipelineType;
    /** Detection magnification ratio (easyocr only). Default: 1.5. */
    magRatio?: number;
    /**
     * EasyOCR `canvas_size`: detection canvas cap (long side, px) applied after
     * `magRatio` scaling. Bounds CRAFT peak memory on dense/high-resolution
     * pages; lower it (e.g. 1280) on memory-constrained targets such as mobile.
     * Default: 2560 (matches `@qvac/ocr-onnx` / EasyOCR). easyocr only.
     */
    canvasSize?: number;
    /** Rotation angles tried when the primary pass is low-confidence (easyocr only). Default: [90, 270]. */
    defaultRotationAngles?: number[];
    /** Retry low-confidence boxes with contrast adjustment (easyocr only). Default: false. */
    contrastRetry?: boolean;
    /** Threshold below which contrast-retry kicks in (easyocr only). Default: 0.4. */
    lowConfidenceThreshold?: number;
    /** Recognizer batch size (easyocr only). Default: 32. */
    recognizerBatchSize?: number;
    /**
     * GGML CPU thread count:
     *   - `0` (default): auto-detect physical cores (hardware_concurrency / 2, floor 1)
     *   - `> 0`: explicit override
     *   - `< 0`: leave GGML's CPU backend default unchanged
     */
    nThreads?: number;
    /** Directory holding ggml backend shared libraries. Default: `<package>/prebuilds`. */
    backendsDir?: string;
    /**
     * Requested ggml backend device. Default: `'cpu'`.
     *   - `'cpu'`: run inference on the CPU backend (always available).
     *   - `'vulkan'`: opt in to GPU inference on a Vulkan-capable device
     *     (Linux/Windows/Android). Requires the `libggml-vulkan` backend shared
     *     library to be present in `backendsDir`.
     *   - `'metal'`: opt in to GPU inference on a Metal-capable device (Apple).
     *     The Metal backend is compiled into the addon, so no extra shared
     *     library is required.
     *   - `'opencl'`: opt in to GPU inference on an OpenCL-capable device
     *     (primarily Android/Adreno, where OpenCL is the sound GPU path).
     *     Requires the `libggml-opencl` backend shared library to be present in
     *     `backendsDir`.
     * When the requested GPU device is not present the pipeline transparently
     * falls back to CPU and records the reason (see
     * {@link BackendInfo.fallbackReason}).
     */
    backendDevice?: "cpu" | "vulkan" | "metal" | "opencl";
    /**
     * Explicit GPU device selection for `'vulkan'` / `'metal'` / `'opencl'`.
     * 0-based index
     * into the GPU/iGPU devices that match the requested backend, in ggml
     * enumeration order (the resolved index is reported as
     * {@link BackendInfo.deviceIndex}).
     *   - When omitted (default), selection prefers a discrete GPU and otherwise
     *     falls back to an integrated GPU.
     *   - When out of range, the pipeline falls back to CPU and records the
     *     reason (see {@link BackendInfo.fallbackReason}).
     * Ignored for `backendDevice: 'cpu'`. For pinning/reordering Vulkan devices
     * without code you can also set the `GGML_VK_VISIBLE_DEVICES` env var (see
     * the README).
     */
    gpuDevice?: number;
}
export type { BackendInfo, OcrGgmlRunOptions };
export interface OcrGgmlArgs {
    params: OcrGgmlParams;
    opts?: {
        stats?: boolean;
    };
    logger?: QvacLogger.LoggerInterface | null;
}
export interface OcrGgmlRunInput {
    /** Path to a JPEG, PNG, or BMP file. */
    path: string;
    options?: OcrGgmlRunOptions;
}
/**
 * One detected text region. Shape matches `@qvac/ocr-onnx` so downstream
 * consumers can swap backends without changing data handling code.
 */
export type InferredText = [
    /** Bounding box: [[x,y], [x,y], [x,y], [x,y]]. */
    [
        [number, number],
        [number, number],
        [number, number],
        [number, number]
    ],
    /** Recognized text. */
    string,
    /** Confidence in [0, 1]. */
    number
];
export interface InferenceClientState {
    configLoaded: boolean;
    weightsLoaded: boolean;
    destroyed: boolean;
}
export interface RuntimeStats {
    /** Total wall-clock time for the run (seconds). */
    totalTime: number;
    /** Detection step duration (seconds). */
    detectionTime: number;
    /** Recognition step duration (seconds). */
    recognitionTime: number;
    /** Number of detected boxes (aligned + unaligned). */
    numBoxes: number;
    /**
     * Whether inference ran on a GPU (Vulkan) device (`1`) or the CPU (`0`).
     * `RuntimeStats` values are numeric only, so this flag is the in-stats signal
     * for the selected backend; richer string detail (name, fallback reason) is
     * available via {@link OcrGgml.getBackendInfo}.
     */
    backendIsGpu: number;
}
/**
 * GGML-backed OCR implementation.
 *
 * Public surface matches `@qvac/ocr-onnx` so a downstream caller can switch
 * inference engines by swapping the import.
 */
export declare class OcrGgml {
    opts: {
        stats?: boolean;
    };
    logger: QvacLogger;
    addon: OcrGgmlInterface | null;
    params: OcrGgmlParams;
    state: InferenceClientState;
    private _packageName;
    private _packageVersion;
    private _job;
    private _run;
    private _backendInfo;
    constructor({ params, opts, logger }: OcrGgmlArgs);
    getState(): InferenceClientState;
    load(): Promise<void>;
    run(input: OcrGgmlRunInput): Promise<QvacResponse<InferredText[]>>;
    /**
     * Backend device the C++ pipeline resolved for inference. Available after
     * `load()`; `null` before load or after unload.
     */
    getBackendInfo(): BackendInfo | null;
    unload(): Promise<void>;
    destroy(): Promise<void>;
    private _load;
    private _createAddon;
    private _runInternal;
    /**
     * Read an image file from disk and prepare it for the addon. Mirrors the
     * ocr-onnx convention: JPEG / PNG are passed encoded to the addon (decoded
     * by OpenCV in C++); BMP is decoded in JS to raw RGB.
     */
    private _readImage;
    private _decodeBmp;
    private _addonOutputCallback;
    /** Inference Manager diagnostics hook (parity with ocr-onnx). */
    _getDiagnosticsJSON(): string;
    /** Inference Manager hooks (parity with ocr-onnx) */
    static inferenceManagerConfig: {
        noAdditionalDownload: boolean;
    };
    static getModelKey(): string;
}
export { QvacErrorAddonOcrGgml, ERR_CODES };
export declare const modelClass: typeof OcrGgml;
export declare const modelFile: unknown;
export declare const binding: unknown;
export declare const addonLogging: unknown;
