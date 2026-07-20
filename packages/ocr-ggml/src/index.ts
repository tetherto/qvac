/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
import path = require("bare-path");
import fs = require("bare-fs");
import QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  createJobHandler,
  exclusiveRunQueue,
  type JobHandler,
  type QvacResponse,
} from "@qvac/infer-base";

import {
  OcrGgmlInterface,
  type BackendInfo,
  type OcrGgmlBinding,
  type OcrGgmlConfigurationParams,
  type OcrGgmlRunOptions,
} from "./ocr-ggml";
import { QvacErrorAddonOcrGgml, ERR_CODES, errorMessage } from "./lib/error";

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
  opts?: { stats?: boolean };
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
  [[number, number], [number, number], [number, number], [number, number]],
  /** Recognized text. */
  string,
  /** Confidence in [0, 1]. */
  number,
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

interface ReadImageResult {
  data: Buffer;
  isEncoded?: boolean;
  width?: number;
  height?: number;
  bitsPerPixel?: number;
}

type RunExclusive = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * GGML-backed OCR implementation.
 *
 * Public surface matches `@qvac/ocr-onnx` so a downstream caller can switch
 * inference engines by swapping the import.
 */
export class OcrGgml {
  opts: { stats?: boolean };
  logger: QvacLogger;
  addon: OcrGgmlInterface | null;
  params: OcrGgmlParams;
  state: InferenceClientState;

  private _packageName: string;
  private _packageVersion: string;
  private _job: JobHandler;
  private _run: RunExclusive;
  private _backendInfo: BackendInfo | null;

  constructor({ params, opts = {}, logger = null }: OcrGgmlArgs) {
    this.opts = opts;
    this.logger = new QvacLogger(logger as QvacLogger.LoggerInterface);
    this.addon = null;
    this.params = params;
    this._packageName = "@qvac/ocr-ggml";
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- package metadata is read from the package root at runtime.
    this._packageVersion = (require("./package.json") as { version: string }).version;
    this._job = createJobHandler({ cancel: () => this.addon?.cancel() });
    this._run = exclusiveRunQueue() as RunExclusive;
    this._backendInfo = null;

    this.state = {
      configLoaded: false,
      weightsLoaded: false,
      destroyed: false,
    };
  }

  getState(): InferenceClientState {
    return this.state;
  }

  async load(): Promise<void> {
    if (this.state.configLoaded || this.state.weightsLoaded) {
      this.logger.info("Reload requested - unloading existing model first");
      await this.unload();
    }
    await this._load();
  }

  async run(input: OcrGgmlRunInput): Promise<QvacResponse<InferredText[]>> {
    return this._run(() => this._runInternal(input));
  }

  /**
   * Backend device the C++ pipeline resolved for inference. Available after
   * `load()`; `null` before load or after unload.
   */
  getBackendInfo(): BackendInfo | null {
    return this._backendInfo;
  }

  async unload(): Promise<void> {
    if (this.addon) {
      await this.addon.destroy();
      this.addon = null;
    }
    this._backendInfo = null;
    this.state.configLoaded = false;
    this.state.weightsLoaded = false;
  }

  async destroy(): Promise<void> {
    await this.unload();
    this.state.destroyed = true;
  }

  private async _load(): Promise<void> {
    if (!this.params || typeof this.params !== "object") {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.MISSING_REQUIRED_PARAMETER,
        adds: "params object is required",
      });
    }

    if (!this.params.pathDetector) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.MISSING_REQUIRED_PARAMETER,
        adds: "pathDetector",
      });
    }
    if (!this.params.pathRecognizer) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.MISSING_REQUIRED_PARAMETER,
        adds: "pathRecognizer",
      });
    }
    if (!Array.isArray(this.params.langList) || this.params.langList.length === 0) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.MISSING_REQUIRED_PARAMETER,
        adds: "langList (non-empty array)",
      });
    }

    const SUPPORTED_LANGUAGES = new Set(["en"]);
    const hasSupported = this.params.langList.some((l) => SUPPORTED_LANGUAGES.has(l));
    if (!hasSupported) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.UNSUPPORTED_LANGUAGE,
        adds: `none of the requested languages are supported: ${this.params.langList.join(", ")}`,
      });
    }

    const configurationParams: OcrGgmlConfigurationParams = {
      pathDetector: this.params.pathDetector,
      pathRecognizer: this.params.pathRecognizer,
      langList: this.params.langList,
    };

    // Forward optional config knobs only when explicitly set so the C++
    // defaults (in OcrConfig) win otherwise.
    const optionalFields: (keyof OcrGgmlParams)[] = [
      "magRatio",
      "canvasSize",
      "defaultRotationAngles",
      "contrastRetry",
      "lowConfidenceThreshold",
      "recognizerBatchSize",
      "nThreads",
      "pipelineType",
      "backendDevice",
      "gpuDevice",
    ];
    for (const field of optionalFields) {
      if (this.params[field] !== undefined) {
        (configurationParams as Record<string, unknown>)[field] = this.params[field];
      }
    }

    configurationParams.backendsDir =
      this.params.backendsDir !== undefined
        ? this.params.backendsDir
        : path.join(__dirname, "prebuilds");

    this.logger.info("Creating ocr-ggml addon");
    this.addon = this._createAddon(configurationParams);
    await this.addon.activate();
    this.state.configLoaded = true;
    this.state.weightsLoaded = true;

    // Capture the backend device the C++ pipeline actually resolved (Vulkan vs
    // CPU fallback). RuntimeStats can only carry numbers, so backend identity
    // strings are surfaced here and via _getDiagnosticsJSON().
    try {
      this._backendInfo = this.addon.getBackendInfo();
      if (this._backendInfo) {
        this.logger.info("ocr-ggml backend: " + JSON.stringify(this._backendInfo));
      }
    } catch (err) {
      this.logger.warn("ocr-ggml: failed to read backend info: " + errorMessage(err));
      this._backendInfo = null;
    }

    this.logger.info("ocr-ggml model loaded");
  }

  private _createAddon(configurationParams: OcrGgmlConfigurationParams): OcrGgmlInterface {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require("./binding") as OcrGgmlBinding;
    return new OcrGgmlInterface(
      binding,
      configurationParams,
      this._addonOutputCallback.bind(this),
      this.logger,
    );
  }

  private async _runInternal(input: OcrGgmlRunInput): Promise<QvacResponse<InferredText[]>> {
    this.logger.info("Starting OCR inference");

    if (!this.addon) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.NOT_LOADED,
        adds: "call load() before run()",
      });
    }

    const response = this._job.start() as QvacResponse<InferredText[]>;
    try {
      const imageInput = this._readImage(input.path);
      await this.addon.runJob({
        type: "image",
        input: imageInput,
        options: input.options,
      });
    } catch (err) {
      this._job.fail(err as Error);
      throw err;
    }
    return response;
  }

  /**
   * Read an image file from disk and prepare it for the addon. Mirrors the
   * ocr-onnx convention: JPEG / PNG are passed encoded to the addon (decoded
   * by OpenCV in C++); BMP is decoded in JS to raw RGB.
   */
  private _readImage(imagePath: string): ReadImageResult {
    this.logger.debug("Reading image from path:", imagePath);
    const contents = fs.readFileSync(imagePath);
    if (!contents || contents.length < 4) {
      this.logger.error("Invalid image file or insufficient data");
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.INVALID_IMAGE_OR_INSUFFICIENT_DATA,
        adds: imagePath,
      });
    }

    // JPEG: starts with 0xFF 0xD8
    if (contents[0] === 0xff && contents[1] === 0xd8) {
      return { data: contents, isEncoded: true };
    }
    // PNG: 0x89 P N G
    if (
      contents[0] === 0x89 &&
      contents[1] === 0x50 &&
      contents[2] === 0x4e &&
      contents[3] === 0x47
    ) {
      return { data: contents, isEncoded: true };
    }
    // BMP: 'BM'
    if (contents[0] === 0x42 && contents[1] === 0x4d) {
      return this._decodeBmp(contents, imagePath);
    }

    this.logger.error("Unsupported image format");
    throw new QvacErrorAddonOcrGgml({
      code: ERR_CODES.UNSUPPORTED_IMAGE_FORMAT,
      adds: imagePath,
    });
  }

  private _decodeBmp(contents: Buffer, imagePath: string): ReadImageResult {
    if (contents.length < 14 + 4) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.INVALID_IMAGE_OR_INSUFFICIENT_DATA,
        adds: imagePath,
      });
    }

    const infoHeaderSize = contents.readUInt32LE(14);
    if (contents.length < 14 + infoHeaderSize) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.INVALID_IMAGE_OR_INSUFFICIENT_DATA,
        adds: imagePath,
      });
    }

    let width: number, height: number, bitsPerPixel: number;
    if (infoHeaderSize >= 40) {
      width = contents.readInt32LE(18);
      height = contents.readInt32LE(22);
      bitsPerPixel = contents.readUInt16LE(28);
    } else if (infoHeaderSize >= 12) {
      width = contents.readUInt16LE(18);
      height = contents.readInt16LE(20);
      bitsPerPixel = 24;
    } else {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.UNSUPPORTED_IMAGE_FORMAT,
        adds: `BMP header size ${infoHeaderSize}`,
      });
    }

    if (width <= 0 || height === 0) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.INVALID_IMAGE_OR_INSUFFICIENT_DATA,
        adds: `${imagePath} (invalid BMP dimensions ${width}x${height})`,
      });
    }

    const SUPPORTED_BITS = new Set([8, 24, 32]);
    if (!SUPPORTED_BITS.has(bitsPerPixel)) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.UNSUPPORTED_IMAGE_FORMAT,
        adds: `BMP bitsPerPixel ${bitsPerPixel} (supported: 8, 24, 32)`,
      });
    }

    const pixelDataOffset = contents.readUInt32LE(10);
    if (pixelDataOffset >= contents.length) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.INVALID_IMAGE_OR_INSUFFICIENT_DATA,
        adds: `${imagePath} (BMP pixelDataOffset ${pixelDataOffset} out of range)`,
      });
    }
    const pixelDataBuffer = contents.slice(pixelDataOffset);

    const bytesPerPixel = bitsPerPixel / 8;
    const unpaddedRowSize = width * bytesPerPixel;
    const paddedRowSize = Math.ceil(unpaddedRowSize / 4) * 4;
    const rows = Math.abs(height);

    if (pixelDataBuffer.length < rows * paddedRowSize) {
      throw new QvacErrorAddonOcrGgml({
        code: ERR_CODES.INVALID_IMAGE_OR_INSUFFICIENT_DATA,
        adds: imagePath,
      });
    }

    const unpaddedData = Buffer.alloc(rows * unpaddedRowSize);
    for (let row = 0; row < rows; row++) {
      const srcStart = row * paddedRowSize;
      const srcEnd = srcStart + unpaddedRowSize;
      let destRow = row;
      if (height > 0) destRow = rows - row - 1;
      const destStart = destRow * unpaddedRowSize;
      pixelDataBuffer.copy(unpaddedData, destStart, srcStart, srcEnd);
    }

    return { width, height: rows, data: unpaddedData, bitsPerPixel };
  }

  private _addonOutputCallback(
    _addon: unknown,
    event: unknown,
    data: unknown,
    error: unknown,
  ): void {
    if (typeof event === "string" && event.includes("Error")) {
      return this._job.fail(error as Error);
    }

    // JobEnded may arrive with stats payload, with null (stats disabled), or
    // not at all on some platforms - handle the event name explicitly so
    // await() doesn't hang when data is null.
    if (event === "JobEnded") {
      const isStatsObject =
        typeof data === "object" &&
        data !== null &&
        !Array.isArray(data) &&
        ("totalTime" in data || "detectionTime" in data);
      if (isStatsObject) {
        this.logger.info("OCR inference completed. Stats:", JSON.stringify(data));
      }
      return this._job.end(this.opts?.stats && isStatsObject ? data : null);
    }

    // Some addon paths surface stats without a 'JobEnded' event name; keep
    // the legacy heuristic as a fallback so we still close the job.
    const isStatsObject =
      typeof data === "object" &&
      data !== null &&
      !Array.isArray(data) &&
      ("totalTime" in data || "detectionTime" in data);
    if (isStatsObject) {
      this.logger.info("OCR inference completed. Stats:", JSON.stringify(data));
      return this._job.end(this.opts?.stats ? data : null);
    }

    if (Array.isArray(data)) {
      return this._job.output(data);
    }
  }

  /** Inference Manager diagnostics hook (parity with ocr-onnx). */
  _getDiagnosticsJSON(): string {
    return JSON.stringify({
      status: this.state.destroyed
        ? "destroyed"
        : this.state.configLoaded
          ? "loaded"
          : "not_loaded",
      params: this.params,
      backend: this._backendInfo,
    });
  }

  /** Inference Manager hooks (parity with ocr-onnx) */
  static inferenceManagerConfig = {
    noAdditionalDownload: true,
  };

  static getModelKey(): string {
    return "ocr-ggml";
  }
}

export { QvacErrorAddonOcrGgml, ERR_CODES };

export declare const modelClass: typeof OcrGgml;
export declare const modelFile: unknown;
export declare const binding: unknown;
export declare const addonLogging: unknown;

module.exports = {
  OcrGgml,
  modelClass: OcrGgml,
  get modelFile() {
    return (require as unknown as { addon: { resolve(id: string): unknown } }).addon.resolve(".");
  },
  QvacErrorAddonOcrGgml,
  ERR_CODES,
  get binding() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    return require("./binding") as unknown;
  },
  get addonLogging() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- resolved lazily to defer native binding load.
    return require("./addonLogging") as unknown;
  },
};
