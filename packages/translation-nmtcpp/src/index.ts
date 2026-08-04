/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
import path = require("bare-path");
import QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  QvacResponse,
  createJobHandler,
  exclusiveRunQueue,
  type JobHandler,
} from "@qvac/infer-base";

import {
  TranslationInterface,
  type TranslationConfigurationParams,
} from "./marian";
import { IndicProcessor } from "./third-party/indic-processor";

interface QvacResponseHandlers {
  cancelHandler: () => Promise<void>;
  signal?: AbortSignal;
}

class QvacIndicTransResponse extends QvacResponse<string> {
  private readonly processor: IndicProcessor;
  private readonly dstLang: string;

  /**
   * Creates an instance of QvacIndicTransResponse.
   */
  constructor(
    processor: IndicProcessor,
    dstLang: string,
    handlers: QvacResponseHandlers,
  ) {
    super(handlers);
    this.processor = processor;
    this.dstLang = dstLang;
  }

  onCancel(callback: () => void) {
    return super.onCancel(callback);
  }

  onError(callback: (error: Error) => void) {
    return super.onError(callback);
  }

  onFinish(callback?: (result: string[]) => void) {
    return super.onFinish(callback);
  }

  onUpdate(callback: (data: string) => void) {
    return super.onUpdate((data) => {
      const [postProcessedText] = this.processor.postprocessBatch(
        [data],
        this.dstLang,
      );
      return callback(postProcessedText);
    });
  }

  async *iterate(): AsyncIterableIterator<string> {
    for await (const output of super.iterate()) {
      const [postProcessedText] = this.processor.postprocessBatch(
        [output],
        this.dstLang,
      );
      yield postProcessedText;
    }
  }
}

// Aliases for the namespace types: the class expression's inner name shadows
// the outer `TranslationNmtcpp` binding, so the body cannot qualify them.
type TranslationNmtcppArgs = TranslationNmtcpp.TranslationNmtcppArgs;
type TranslationNmtcppConfig = TranslationNmtcpp.TranslationNmtcppConfig;
type TranslationNmtcppFiles = TranslationNmtcpp.TranslationNmtcppFiles;
type TranslationNmtcppParams = TranslationNmtcpp.TranslationNmtcppParams;
type TranslationNmtcppModelTypes = TranslationNmtcpp.TranslationNmtcppModelTypes;
type InferenceClientState = TranslationNmtcpp.InferenceClientState;

/**
 * Public instance surface of a translation model. Kept as an interface (public
 * members only) so the published type stays structural — emitting the class
 * type would leak private fields and reject consumer mocks.
 */
interface TranslationNmtcpp {
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
   */
  run(input: string): Promise<QvacResponse<string>>;
  /**
   * Translates multiple texts in a single batch for better performance.
   */
  runBatch(texts: string[]): Promise<string[]>;
  /**
   * Unloads the model and frees resources.
   */
  unload(): Promise<void>;
  /**
   * Destroys the model permanently.
   */
  destroy(): Promise<void>;
  /**
   * Returns the name of the compute backend that load() actually selected,
   * or one of the sentinels "Unloaded", "Bergamot-CPU", "CPU". Open-ended
   * device names like "Vulkan0", "OpenCL", "Metal" are also possible.
   *
   * Return-type note: `(string & {})` keeps the literal sentinels
   * IDE-completable. Plain `'Unloaded' | ... | string` collapses to `string`
   * via TypeScript's union absorption rule.
   */
  getActiveBackendName(): "Unloaded" | "Bergamot-CPU" | "CPU" | (string & {});
  /**
   * Returns the human-readable device description for the active GPU backend
   * (e.g. 'NVIDIA GeForce RTX 5070', 'Intel(R) UHD Graphics').
   * Returns '' when no GPU backend is loaded or model is unloaded.
   */
  getActiveBackendDescription(): string;
}

/**
 * Static/constructor surface — what `module.exports` itself provides.
 */
interface TranslationNmtcppConstructor {
  new (args: TranslationNmtcppArgs): TranslationNmtcpp;
  /**
   * Available model types for translation
   */
  readonly ModelTypes: TranslationNmtcppModelTypes;
}

/**
 * TranslationNmtcpp implementation for Marian/IndicTrans/Bergamot translation models
 */
const TranslationNmtcpp: TranslationNmtcppConstructor = class TranslationNmtcpp {
  /**
   * Available model types for translation
   */
  static readonly ModelTypes: TranslationNmtcppModelTypes = {
    IndicTrans: "IndicTrans",
    Bergamot: "Bergamot",
  };

  private readonly opts: { stats?: boolean };
  readonly logger: QvacLogger;
  private addon: TranslationInterface | null;
  private state: InferenceClientState;
  private readonly _modelType: string | undefined;
  private readonly _files: TranslationNmtcppFiles;
  private readonly _config: Record<string, unknown>;
  private readonly _params: TranslationNmtcppParams;
  private readonly _pivotConfig: Record<string, unknown>;
  private readonly _job: JobHandler;
  private readonly _run: ReturnType<typeof exclusiveRunQueue>;

  /**
   * Creates an instance of TranslationNmtcpp.
   */
  constructor({
    files,
    params,
    config = {} as TranslationNmtcppConfig,
    logger = null,
    opts = {},
  }: TranslationNmtcppArgs) {
    this.opts = opts;
    this.logger = new QvacLogger(logger as QvacLogger.LoggerInterface);
    this.addon = null;

    this.state = {
      configLoaded: false,
      weightsLoaded: false,
      destroyed: false,
    };

    const { modelType, pivotConfig, ...additionalConfig } = config;

    this._modelType = modelType;

    if (this._modelType === "Opus") {
      throw new Error(
        "ModelTypes.Opus has been deprecated. Use ModelTypes.Bergamot instead. " +
          "Bergamot covers European language pairs and supports pivot translation for non-English pairs via PivotTranslationModel.",
      );
    }

    this._files = files;
    this._config = additionalConfig;
    this._params = params;
    this._pivotConfig = pivotConfig || {};
    this._job = createJobHandler({ cancel: () => this.addon!.cancel() });
    this._run = exclusiveRunQueue();
  }

  /**
   * Returns the current state of the inference client.
   */
  getState(): InferenceClientState {
    return this.state;
  }

  /**
   * Loads the model. If already loaded, unloads first.
   */
  async load(): Promise<void> {
    if (this.state.configLoaded || this.state.weightsLoaded) {
      this.logger.info("Reload requested - unloading existing model first");
      await this.unload();
    }

    await this._load();
  }

  /**
   * Runs inference on the given input. Serialized — only one job at a time.
   * @param input - Text to translate
   */
  async run(input: string): Promise<QvacResponse<string>> {
    return this._run(() =>
      this._runInternal(input),
    ) as Promise<QvacResponse<string>>;
  }

  /**
   * Unloads the model and frees resources.
   */
  async unload(): Promise<void> {
    if (this.addon) {
      await this.addon.destroy();
      this.addon = null;
    }
    this.state.configLoaded = false;
    this.state.weightsLoaded = false;
  }

  /**
   * Destroys the model permanently.
   */
  async destroy(): Promise<void> {
    await this.unload();
    this.state.destroyed = true;
  }

  /**
   * Returns the name of the currently-loaded non-CPU backend (e.g. 'Vulkan0',
   * 'OpenCL', 'Metal'), or a sentinel:
   *   - 'Unloaded'     — model is not loaded
   *   - 'Bergamot-CPU' — Bergamot model (CPU-only by design)
   *   - 'CPU'          — GGML backend loaded, only CPU backend registered
   */
  getActiveBackendName(): "Unloaded" | "Bergamot-CPU" | "CPU" | (string & {}) {
    if (!this.addon) {
      return "Unloaded";
    }
    return this.addon.getActiveBackendName();
  }

  /**
   * Returns the human-readable device description for the active GPU backend
   * (e.g. 'NVIDIA GeForce RTX 5070', 'Intel(R) UHD Graphics').
   * Returns '' when no GPU backend is loaded or model is unloaded.
   */
  getActiveBackendDescription(): string {
    if (!this.addon) {
      return "";
    }
    return this.addon.getActiveBackendDescription();
  }

  /**
   * Checks if this is a Bergamot model
   */
  private _isBergamotModel(): boolean {
    return this._modelType === TranslationNmtcpp.ModelTypes.Bergamot;
  }

  /**
   * Configures Bergamot-specific parameters
   */
  private _configureBergamotModel(
    configurationParams: TranslationConfigurationParams,
  ): void {
    if (!this._isBergamotModel()) return;

    const vocabConfig: Record<string, unknown> = {};
    if (this._files.srcVocab) {
      vocabConfig.src_vocab = this._files.srcVocab;
    }
    if (this._files.dstVocab) {
      vocabConfig.dst_vocab = this._files.dstVocab;
    }

    if (Object.keys(vocabConfig).length > 0) {
      configurationParams.config = {
        ...configurationParams.config,
        ...vocabConfig,
      };
    }

    if (this._files.pivotModel) {
      const pivotConfig: { path: string; config: Record<string, unknown> } = {
        path: this._files.pivotModel,
        config: { ...this._pivotConfig },
      };

      if (this._files.pivotSrcVocab) {
        pivotConfig.config.src_vocab = this._files.pivotSrcVocab;
      }
      if (this._files.pivotDstVocab) {
        pivotConfig.config.dst_vocab = this._files.pivotDstVocab;
      }

      configurationParams.config = {
        ...configurationParams.config,
        pivotModel: pivotConfig,
      };
    }
  }

  private async _load(): Promise<void> {
    const otherConfig: Record<string, unknown> = { ...this._config };

    // Accept camelCase aliases for the GPU keys so the config object can
    // stay consistent with backendsDir/openclCacheDir. The C++ binding
    // expects snake_case (mirrors nmt_context_params field names), so we
    // translate camelCase → snake_case here. snake_case takes precedence
    // when both are present (explicit user choice wins over alias).
    if (otherConfig.use_gpu === undefined && otherConfig.useGPU !== undefined) {
      otherConfig.use_gpu = otherConfig.useGPU;
    }
    if (
      otherConfig.gpu_backend === undefined &&
      otherConfig.gpuBackend !== undefined
    ) {
      otherConfig.gpu_backend = otherConfig.gpuBackend;
    }
    if (
      otherConfig.gpu_device === undefined &&
      otherConfig.gpuDevice !== undefined
    ) {
      otherConfig.gpu_device = otherConfig.gpuDevice;
    }
    if (
      otherConfig.op_offload_min_batch === undefined &&
      otherConfig.opOffloadMinBatch !== undefined
    ) {
      otherConfig.op_offload_min_batch = otherConfig.opOffloadMinBatch;
    }
    delete otherConfig.useGPU;
    delete otherConfig.gpuBackend;
    delete otherConfig.gpuDevice;
    delete otherConfig.opOffloadMinBatch;

    if (otherConfig.backendsDir === undefined) {
      otherConfig.backendsDir = path.join(__dirname, "prebuilds");
    }

    const configurationParams: TranslationConfigurationParams = {
      path: this._files.model,
      config: otherConfig,
    };

    this._configureBergamotModel(configurationParams);

    this.addon = new TranslationInterface(
      configurationParams,
      this._addonOutputCallback.bind(this),
      this.logger,
    );
    await this.addon.activate();
    this.state.configLoaded = true;
  }

  /**
   * Handles IndicTrans model translation
   */
  private async _runIndicTrans(input: string): Promise<QvacResponse<string>> {
    const processor = new IndicProcessor();
    const [processedText] = processor.preprocessBatch(
      [input],
      this._params.srcLang,
      this._params.dstLang,
    );

    await this.addon!.runJob({
      type: "text",
      input: processedText,
    });

    const response = new QvacIndicTransResponse(processor, this._params.dstLang, {
      cancelHandler: () => this.addon!.cancel(),
    });

    return this._job.startWith(response) as QvacResponse<string>;
  }

  /**
   * Prepares input text with language prefix if needed
   */
  private _prepareInputText(input: string): string {
    if (this._params.srcLang === "en" && this._params.dstLang === "pt") {
      return `>>por<< ${input}`;
    }
    return input;
  }

  /**
   * Creates a response with output post-processing for language prefixes
   */
  private _createStandardResponse(): QvacResponse<string> {
    const response = new QvacResponse<string>({
      cancelHandler: () => this.addon!.cancel(),
    });

    const originalOnUpdate = response.onUpdate.bind(response);
    response.onUpdate = function (callback: (data: string) => void) {
      return originalOnUpdate((data) => {
        const cleanedData = data.replace(/^>>[a-z]+\s*<<\s*/i, "");
        return callback(cleanedData);
      });
    };

    return response;
  }

  /**
   * Handles standard model translation (Bergamot)
   */
  private async _runStandardTranslation(
    input: string,
  ): Promise<QvacResponse<string>> {
    const text = this._prepareInputText(input);
    await this.addon!.runJob({ type: "text", input: text });
    const response = this._createStandardResponse();

    return this._job.startWith(response) as QvacResponse<string>;
  }

  private async _runInternal(input: string): Promise<QvacResponse<string>> {
    if (this._modelType === TranslationNmtcpp.ModelTypes.IndicTrans) {
      return this._runIndicTrans(input);
    }
    return this._runStandardTranslation(input);
  }

  /**
   * Translates multiple texts in a single batch for better performance.
   *
   * @param texts - Array of texts to translate
   * @returns Array of translated texts (same order as input)
   */
  async runBatch(texts: string[]): Promise<string[]> {
    if (!this.addon) {
      throw new Error("Model not loaded. Call load() first.");
    }

    if (!Array.isArray(texts)) {
      throw new Error("Input must be an array of strings");
    }

    let processedTexts = texts;
    let processor: IndicProcessor | null = null;

    if (this._modelType === TranslationNmtcpp.ModelTypes.IndicTrans) {
      processor = new IndicProcessor();
      processedTexts = processor.preprocessBatch(
        texts,
        this._params.srcLang,
        this._params.dstLang,
      );
    } else {
      processedTexts = texts.map((text) => this._prepareInputText(text));
    }

    await this.addon.runJob({ type: "sequences", input: processedTexts });

    const response = this._job.start();

    return new Promise<string[]>((resolve, reject) => {
      response
        .onFinish((result: string[][]) => {
          const [batchResults] = result;
          if (
            this._modelType === TranslationNmtcpp.ModelTypes.IndicTrans &&
            processor
          ) {
            resolve(processor.postprocessBatch(batchResults, this._params.dstLang));
          } else {
            const cleanedResults = batchResults.map((text) =>
              text.replace(/^>>[a-z]+\s*<<\s*/i, ""),
            );
            resolve(cleanedResults);
          }
        })
        .onError((error) => {
          reject(error);
        });
    });
  }

  private _addonOutputCallback(
    _addon: unknown,
    event: string,
    data: unknown,
    error: unknown,
  ): void {
    const isStatsObject =
      typeof data === "object" &&
      data !== null &&
      !Array.isArray(data) &&
      Object.keys(data).some((k) => k.endsWith("TPS"));

    if (isStatsObject) {
      this._job.end(this.opts?.stats ? data : null);
      return;
    }

    if (event.includes("Error")) {
      this._job.fail(error as Error);
      return;
    }

    if (typeof data === "string" || Array.isArray(data)) {
      this._job.output(data);
    }
  }
};

/**
 * Public types, merged with the `TranslationNmtcpp` value for the `export =`
 * consumers. Must stay types-only so tsc emits no runtime code for it and
 * `module.exports` remains the bare class.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace -- class/namespace merging is the only way to type a constructor-first CommonJS export.
namespace TranslationNmtcpp {
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
    opts?: { stats?: boolean };
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
     * sibling-addon convention (caps acronym). Both forms are accepted; if
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
     * `gpuBackend` is the camelCase alias matching the sibling-addon convention.
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
}

export = TranslationNmtcpp;
