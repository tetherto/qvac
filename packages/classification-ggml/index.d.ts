/**
 * Canonical labels emitted by the bundled 3-class MobileNetV3-Small model.
 * Kept permissive for future fine-tunes that ship different class names
 * via the GGUF `mobilenet.class_N` metadata.
 */
export type ClassificationLabel = string;
export interface ClassificationResult {
    /** Human-readable class label, sourced from the GGUF metadata (`mobilenet.class_N`). */
    label: ClassificationLabel;
    /** Softmax probability in `[0, 1]`. Values across all classes sum to approximately 1. */
    confidence: number;
}
export interface ClassifyOptions {
    /** If set, limits the returned list to the top-K classes. Default: all classes. */
    topK?: number;
    /** Width (pixels). Required when passing raw RGB bytes. */
    width?: number;
    /** Height (pixels). Required when passing raw RGB bytes. */
    height?: number;
    /** Channel count. Must be `3` when passing raw RGB bytes. */
    channels?: 3;
}
export interface ImageClassifierLogger {
    error?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
    getLevel?: () => string;
}
export interface ImageClassifierOptions {
    /**
     * Absolute path to the FP16 GGUF weights file. Defaults to the bundled
     * `weights/mobilenetv3_3class_v3_fp16.gguf` shipped inside this package.
     */
    modelPath?: string;
    /** Optional logger compatible with `@qvac/logging`. */
    logger?: ImageClassifierLogger;
    /**
     * When true, forwards native C++ log messages (`QLOG(...)` calls inside
     * the addon) to the JS `logger`. Disabled by default: the underlying
     * shared native logger singleton is not safe across rapid
     * create/destroy cycles. JS-level logging (`load()` / `classify()` info
     * lines from `index.js`) is always routed to `logger` regardless of
     * this flag.
     */
    nativeLogger?: boolean;
}
export interface ImageClassifierState {
    configLoaded: boolean;
    destroyed: boolean;
}
/**
 * High-level classifier for MobileNetV3-Small 3-class image triage.
 *
 * ```js
 * const classifier = new ImageClassifier()
 * await classifier.load()
 * const result = await classifier.classify(jpegBuffer)
 * // [ { label: 'food', confidence: 0.93 }, ... ]
 * await classifier.unload()
 * ```
 */
export declare class ImageClassifier {
    readonly logger: ImageClassifierLogger;
    private readonly modelPath;
    private readonly nativeLogger;
    private addon;
    private readonly job;
    private readonly runExclusive;
    private hasActiveResponse;
    private state;
    constructor(opts?: ImageClassifierOptions);
    getState(): ImageClassifierState;
    /** Loads the model and native resources. Idempotent. */
    load(): Promise<void>;
    private loadInternal;
    private createAddon;
    /**
     * Classifies one image.
     *
     * @param imageInput JPEG/PNG buffer, or raw RGB bytes with
     *                                `options.width`, `options.height`, `options.channels=3`.
     * @param options
     * @returns sorted by `confidence` descending. Always returns all classes
     *          unless `options.topK` is set.
     */
    classify(imageInput: Uint8Array, options?: ClassifyOptions | undefined): Promise<ClassificationResult[]>;
    private classifyInternal;
    private handleAddonOutputEvent;
    private addonOutputCallback;
    /** Idempotent. Cancels any in-flight job before destroying the handle. */
    unload(): Promise<void>;
    /** Releases native resources and marks this instance as destroyed. */
    destroy(): Promise<void>;
}
export default ImageClassifier;
