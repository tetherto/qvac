import { QvacErrorAddonOcrGgml, ERR_CODES, errorMessage } from "./lib/error";

type NativeLoggerCallback = (priority: number, message: string) => void;

type LogLevel = "error" | "warn" | "info" | "debug";

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
export type OcrGgmlOutputCallback = (
  addon: unknown,
  event: unknown,
  data: unknown,
  error: unknown,
) => void;

/** Native binding surface used by {@link OcrGgmlInterface}. */
export interface OcrGgmlBinding {
  createInstance(
    owner: OcrGgmlInterface,
    configurationParams: OcrGgmlConfigurationParams,
    outputCb: OcrGgmlOutputCallback,
  ): object;
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
export class OcrGgmlInterface {
  private _binding: OcrGgmlBinding;
  private _handle: object | null;
  private _loggerInitialized: boolean;

  /**
   * @param configurationParams - configuration for inference setup
   * @param outputCb - invoked on inference events (output, error, stats)
   * @param transitionCb - optional logger object with `info`/`warn`/`error`/`debug`
   *   methods. When provided, C++ log lines are forwarded via `binding.setLogger`.
   */
  constructor(
    binding: OcrGgmlBinding,
    configurationParams: OcrGgmlConfigurationParams,
    outputCb: OcrGgmlOutputCallback,
    transitionCb: TransitionLogger | null = null,
  ) {
    this._binding = binding;
    this._handle = this._binding.createInstance(
      this,
      configurationParams,
      outputCb,
    );

    this._loggerInitialized = false;
    if (transitionCb && typeof transitionCb === "object") {
      this._binding.setLogger((priority: number, message: string) => {
        const levels: LogLevel[] = ["error", "warn", "info", "debug"];
        const level = levels[priority] || "info";
        // Invoke as a method on the logger object — QvacLogger methods rely
        // on `this` internally, so the call must not be detached.
        if (typeof transitionCb[level] === "function") {
          transitionCb[level](message);
        }
      });
      this._loggerInitialized = true;
    }
  }

  async destroyInstance(): Promise<void> {
    await this.destroy();
  }

  async unload(): Promise<void> {
    await this.destroy();
  }

  /**
   * Moves the addon to LISTENING after construction-time work is finished.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- kept async so synchronous throws surface as promise rejections (preserves the original wrapper behavior).
  async activate(): Promise<void> {
    try {
      this._binding.activate(this._handle);
    } catch (err) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.FAILED_TO_ACTIVATE,
        adds: errorMessage(err),
        cause: err as Error,
      });
    }
  }

  async cancel(): Promise<void> {
    try {
      await this._binding.cancel(this._handle);
    } catch (err) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.FAILED_TO_CANCEL,
        adds: errorMessage(err),
        cause: err as Error,
      });
    }
  }

  /**
   * Submit an OCR inference job.
   * @param data.type - `'image'`
   * @param data.input - either `{ data, isEncoded: true }` for a raw JPEG/PNG
   *   buffer, or `{ data, width, height }` for raw RGB pixels.
   * @param data.options - optional per-run overrides.
   */
  async runJob(data: OcrGgmlJob): Promise<boolean> {
    try {
      // Return the native promise directly (no await): mirrors the original
      // wrapper, where only synchronous throws from invoking runJob are
      // wrapped and async rejections propagate unchanged.
      return this._binding.runJob(this._handle, data);
    } catch (err) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.FAILED_TO_RUN_JOB,
        adds: errorMessage(err),
        cause: err as Error,
      });
    }
  }

  /**
   * Returns the backend device the C++ pipeline resolved for inference.
   */
  getBackendInfo(): BackendInfo | null {
    if (this._handle === null) {
      return null;
    }
    return this._binding.getBackendInfo(this._handle);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- kept async so synchronous throws surface as promise rejections (preserves the original wrapper behavior).
  async destroy(): Promise<void> {
    if (this._handle === null) {
      return;
    }

    try {
      if (this._loggerInitialized) {
        this._binding.releaseLogger();
        this._loggerInitialized = false;
      }

      this._binding.destroyInstance(this._handle);
      this._handle = null;
    } catch (err) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.FAILED_TO_DESTROY,
        adds: errorMessage(err),
        cause: err as Error,
      });
    }
  }
}
