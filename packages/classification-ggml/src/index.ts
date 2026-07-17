/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
import fs = require("bare-fs");
import path = require("bare-path");
import env = require("bare-env");
import QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
import { createJobHandler, exclusiveRunQueue, type JobHandler } from "@qvac/infer-base";
import {
  ClassificationInterface,
  mapAddonEvent,
  type ClassificationBinding,
  type ClassificationConfigurationParams,
  type ClassificationInterfaceOptions,
  type ClassificationJob,
} from "./addon";

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

type RunExclusive = <T>(fn: () => Promise<T>) => Promise<T>;

const DEFAULT_WEIGHTS_FILENAME = "mobilenetv3_3class_v3_fp16.gguf";
const RUN_BUSY_ERROR_MESSAGE =
  "Cannot set new job: a job is already set or being processed";

function resolveDefaultModelPath(): string {
  if (env.QVAC_CLASSIFICATION_MODEL_PATH) {
    return env.QVAC_CLASSIFICATION_MODEL_PATH;
  }
  return path.join(__dirname, "weights", DEFAULT_WEIGHTS_FILENAME);
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return typeof error === "string" ? error : fallback;
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
export class ImageClassifier {
  readonly logger: ImageClassifierLogger;

  private readonly modelPath: string;
  private readonly nativeLogger: boolean;
  private addon: ClassificationInterface | null;
  private readonly job: JobHandler;
  private readonly runExclusive: RunExclusive;
  private hasActiveResponse: boolean;
  private state: ImageClassifierState;

  constructor(opts: ImageClassifierOptions = {}) {
    const { modelPath, logger = undefined, nativeLogger = false } = opts;
    this.modelPath = modelPath ?? resolveDefaultModelPath();
    this.logger = new QvacLogger(logger as QvacLogger.LoggerInterface);
    // Off by default: see `addon.js::_ensureLoggerInstalled` for the
    // process-wide JsLogger lifecycle that opt-in unlocks.
    this.nativeLogger = nativeLogger === true;
    this.addon = null;
    this.job = createJobHandler({ cancel: () => this.addon?.cancel() });
    this.runExclusive = exclusiveRunQueue() as RunExclusive;
    this.hasActiveResponse = false;
    this.state = { configLoaded: false, destroyed: false };
  }

  getState(): ImageClassifierState {
    return { ...this.state };
  }

  /** Loads the model and native resources. Idempotent. */
  async load(): Promise<void> {
    return this.runExclusive(async () => {
      if (this.state.configLoaded) return;
      await this.loadInternal();
      this.state.configLoaded = true;
      this.logger.info?.("ImageClassifier loaded");
    });
  }

  private async loadInternal(): Promise<void> {
    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`MobileNet GGUF weights not found at: ${this.modelPath}`);
    }

    // configurationParams is the C++ schema 1:1. Keep it free of any
    // JS-only flags. The native-logger gate lives in the JS-side opts arg.
    const configurationParams: ClassificationConfigurationParams = {
      path: this.modelPath,
      config: { backendsDir: path.join(__dirname, "prebuilds") },
    };

    const disableNativeLogger =
      !this.nativeLogger || env.QVAC_CLASSIFICATION_DISABLE_NATIVE_LOGGER === "1";

    try {
      this.addon = this.createAddon(configurationParams, { disableNativeLogger });
      await this.addon.activate();
    } catch (loadError) {
      this.logger.error?.("Error during model load:", loadError);
      try {
        await this.addon?.unload?.();
      } catch {}
      this.addon = null;
      throw loadError;
    }
  }

  private createAddon(
    configurationParams: ClassificationConfigurationParams,
    opts: ClassificationInterfaceOptions,
  ): ClassificationInterface {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require("./binding") as ClassificationBinding;
    return new ClassificationInterface(
      binding,
      configurationParams,
      this.addonOutputCallback.bind(this),
      this.logger,
      opts,
    );
  }

  /**
   * Classifies one image.
   *
   * @param imageInput JPEG/PNG buffer, or raw RGB bytes with
   *                                `options.width`, `options.height`, `options.channels=3`.
   * @param options
   * @returns sorted by `confidence` descending. Always returns all classes
   *          unless `options.topK` is set.
   */
  async classify(
    imageInput: Uint8Array,
    options: ClassifyOptions | undefined = undefined,
  ): Promise<ClassificationResult[]> {
    return this.runExclusive(() => this.classifyInternal(imageInput, options));
  }

  private async classifyInternal(
    imageInput: Uint8Array,
    options: ClassifyOptions | undefined,
  ): Promise<ClassificationResult[]> {
    if (!this.addon || !this.state.configLoaded) {
      throw new Error("Classifier not loaded. Call load() first.");
    }
    if (this.hasActiveResponse) {
      throw new Error(RUN_BUSY_ERROR_MESSAGE);
    }

    const job: ClassificationJob = { type: "image", content: imageInput };
    if (options) {
      if (options.width !== undefined) job.width = options.width;
      if (options.height !== undefined) job.height = options.height;
      if (options.channels !== undefined) job.channels = options.channels;
      if (options.topK !== undefined) job.topK = options.topK;
    }

    const response = this.job.start();

    let accepted: boolean;
    try {
      accepted = await this.addon.runJob(job);
    } catch (err) {
      this.job.fail(err as Error);
      throw err;
    }
    if (!accepted) {
      const err = new Error("Classification job was rejected by the native runner");
      this.job.fail(err);
      throw err;
    }

    this.hasActiveResponse = true;
    const collected: unknown = await response.await().finally(() => {
      this.hasActiveResponse = false;
    });
    // QvacResponse collects each Output event into an array; classify
    // emits exactly one, so unwrap to preserve the public shape.
    return Array.isArray(collected) && Array.isArray(collected[0])
      ? (collected[0] as ClassificationResult[])
      : (collected as ClassificationResult[]);
  }

  private handleAddonOutputEvent(
    eventType: unknown,
    data: unknown,
    error: unknown,
  ): void {
    if (eventType === "LogMsg") {
      const msg =
        typeof data === "string"
          ? data
          : getErrorMessage(data, JSON.stringify(data));
      this.logger.info?.(msg);
      return;
    }
    if (eventType === "Error") {
      const err =
        error instanceof Error
          ? error
          : new Error(getErrorMessage(error, "Classification failed"));
      this.job.fail(err);
    } else if (eventType === "Output") {
      this.job.output(data);
    } else if (eventType === "JobEnded") {
      this.job.end();
    }
  }

  private addonOutputCallback(
    _addon: ClassificationInterface,
    event: unknown,
    data: unknown,
    error: unknown,
  ): void {
    const mapped = mapAddonEvent(event, data, error);
    if (mapped === null) return;
    this.handleAddonOutputEvent(mapped.type, mapped.data, mapped.error);
  }

  /** Idempotent. Cancels any in-flight job before destroying the handle. */
  async unload(): Promise<void> {
    return this.runExclusive(async () => {
      try {
        if (this.addon?.cancel) await this.addon.cancel();
      } catch {}
      if (this.job.active) {
        this.job.fail(new Error("Model was unloaded"));
      }
      this.hasActiveResponse = false;
      if (this.addon) {
        await this.addon.unload();
        this.addon = null;
      }
      this.state.configLoaded = false;
    });
  }

  /** Releases native resources and marks this instance as destroyed. */
  async destroy(): Promise<void> {
    await this.unload();
    this.state.destroyed = true;
  }
}

export default ImageClassifier;

const cjsExports = ImageClassifier as typeof ImageClassifier & {
  ImageClassifier?: typeof ImageClassifier;
};
cjsExports.ImageClassifier = ImageClassifier;
module.exports = cjsExports;

