/**
 * Canonical labels emitted by the bundled 3-class MobileNetV3-Small model.
 * The trailing `string` keeps the type permissive for future fine-tunes
 * that ship different class names via the GGUF `mobilenet.class_N`
 * metadata, so narrowing at call sites remains additive / backward
 * compatible.
 */
export type ClassificationLabel =
  | "food"
  | "report"
  | "other"
  | string;

export interface ClassificationResult {
  /** Human-readable class label, sourced from the GGUF metadata (`mobilenet.class_N`). */
  label: ClassificationLabel;
  /** Softmax probability in `[0, 1]`. Values across all classes sum to ≈ 1. */
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
 * MobileNetV3-Small 3-class image classifier backed by libggml on CPU.
 */
export declare class ImageClassifier {
  constructor(opts?: ImageClassifierOptions);

  readonly logger: ImageClassifierLogger;

  /** Loads the model and native resources. Idempotent. */
  load(): Promise<void>;

  /**
   * Classifies an image buffer.
   *
   * @param imageInput JPEG or PNG buffer, or raw RGB bytes accompanied by
   *                   `options.width`, `options.height`, `options.channels`.
   * @param options see `ClassifyOptions`
   */
  classify(
    imageInput: Uint8Array,
    options?: ClassifyOptions,
  ): Promise<ClassificationResult[]>;

  /** Releases native resources. Safe to call multiple times. */
  unload(): Promise<void>;

  /** Releases native resources and marks this instance as destroyed. */
  destroy(): Promise<void>;

  getState(): ImageClassifierState;
}

export default ImageClassifier;
