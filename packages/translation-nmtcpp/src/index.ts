/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
import path = require("bare-path");
import fs = require("bare-fs");
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
  errorMessage,
  type TranslationConfigurationParams,
} from "./marian";
import { IndicProcessor } from "./third-party/indic-processor";

/**
 * Opus-MT-style target-language tokens prepended to the source text for
 * specific Bergamot language pairs. The Firefox Translations en→pt model is a
 * multi-variant export that expects an explicit `>>por<<` token selecting
 * Portuguese output; without it the model can mistranslate or echo a variant
 * token. The output side strips any echoed `>>xxx<<` token (see
 * `_createStandardResponse`). Keyed by `"srcLang:dstLang"`.
 */
const BERGAMOT_TARGET_TOKEN_BY_PAIR: Record<string, string> = {
  "en:pt": ">>por<<",
};

// The ggml compute backends (GGML_BACKEND_DL modules) ship exactly once, in the
// @qvac/fabric dependency (prebuilds/<host>/qvac__fabric). We deliberately do
// not copy them into this addon to avoid duplicating tens of MB per fabric
// consumer. On desktop, resolve the single @qvac/fabric install and load the
// backends from there. On mobile the package tree isn't resolvable at runtime
// (the worklet runs from a packed bundle), so fall back to this addon's own
// prebuilds, where the mobile packaging stages the backends. The native side
// appends BACKENDS_SUBDIR ("<host>/qvac__fabric") to whichever root we return.
function resolveBackendsDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- @qvac/fabric/platform is CJS and absent from 0.10.0 fat installs.
    const fabricPlatform = require("@qvac/fabric/platform") as {
      resolvePlatformPrebuilds: () => string | null;
    };
    const fabricPrebuilds = fabricPlatform.resolvePlatformPrebuilds();
    if (fabricPrebuilds && fs.existsSync(fabricPrebuilds)) return fabricPrebuilds;
  } catch {}
  try {
    const fabricPkg = require.resolve("@qvac/fabric/package");
    const fabricPrebuilds = path.join(path.dirname(fabricPkg), "prebuilds");
    if (fs.existsSync(fabricPrebuilds)) return fabricPrebuilds;
  } catch {
    // Mobile worklets cannot resolve the @qvac/fabric package tree.
  }
  return path.join(__dirname, "prebuilds");
}

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
type TranslationResponse = TranslationNmtcpp.TranslationResponse;

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
   * Loads the model. If already loaded, unloads first. Rejects after
   * `destroy()` — destruction is permanent; create a new instance instead.
   */
  load(): Promise<void>;
  /**
   * Runs inference on the given input. Serialized through completion — the
   * next `run()`/`runBatch()` job starts only after the returned response
   * has settled (finished, failed, or been cancelled).
   */
  run(input: string): Promise<TranslationResponse>;
  /**
   * Translates multiple texts in a single batch for better performance.
   * Serialized with `run()` through the same queue.
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
   * Loads the model. If already loaded, unloads first. Rejects after
   * `destroy()` — destruction is permanent; create a new instance instead.
   */
  async load(): Promise<void> {
    if (this.state.destroyed) {
      throw new Error(
        "Model has been destroyed. Create a new instance to load again.",
      );
    }

    if (this.state.configLoaded || this.state.weightsLoaded) {
      this.logger.info("Reload requested - unloading existing model first");
      await this.unload();
    }

    await this._load();
  }

  /**
   * Runs inference on the given input. Serialized through completion — the
   * queue slot is held until the returned response settles, so a following
   * `run()`/`runBatch()` cannot replace an in-flight job.
   * @param input - Text to translate
   */
  async run(input: string): Promise<TranslationResponse> {
    return new Promise<TranslationResponse>((resolve, reject) => {
      void this._run(async () => {
        let response: TranslationResponse;
        try {
          response = await this._runInternal(input);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(errorMessage(err)));
          return;
        }
        resolve(response);
        await (response.await() as Promise<unknown>).catch(() => {});
      });
    });
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

  private _createAddon(
    configurationParams: TranslationConfigurationParams,
  ): TranslationInterface {
    return new TranslationInterface(
      configurationParams,
      this._addonOutputCallback.bind(this),
      this.logger,
    );
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
      otherConfig.backendsDir = resolveBackendsDir();
    }

    const configurationParams: TranslationConfigurationParams = {
      path: this._files.model,
      config: otherConfig,
    };

    this._configureBergamotModel(configurationParams);

    this.addon = this._createAddon(configurationParams);
    try {
      await this.addon.activate();
    } catch (err) {
      // A failed activation must not leak the native instance or keep the
      // global C++ → JS logger bridge registered; destroy() releases both.
      try {
        await this.addon.destroy();
      } catch (cleanupErr) {
        this.logger.warn(
          "translation-nmtcpp: cleanup after failed activation failed: " +
            errorMessage(cleanupErr),
        );
      }
      this.addon = null;
      throw err;
    }
    this.state.configLoaded = true;
    this.state.weightsLoaded = true;
  }

  /**
   * Handles IndicTrans model translation
   */
  private async _runIndicTrans(input: string): Promise<TranslationResponse> {
    const processor = new IndicProcessor();
    const [processedText] = processor.preprocessBatch(
      [input],
      this._params.srcLang,
      this._params.dstLang,
    );

    const response = new QvacIndicTransResponse(processor, this._params.dstLang, {
      cancelHandler: () => this.addon!.cancel(),
    });
    this._job.startWith(response);

    try {
      await this.addon!.runJob({
        type: "text",
        input: processedText,
      });
    } catch (err) {
      this._job.fail(err as Error);
      throw err;
    }

    return response as unknown as TranslationResponse;
  }

  /**
   * Prepends the Opus-MT-style target-language token when the active
   * language pair requires one (see BERGAMOT_TARGET_TOKEN_BY_PAIR).
   */
  private _prepareInputText(input: string): string {
    const targetToken =
      BERGAMOT_TARGET_TOKEN_BY_PAIR[
        `${this._params.srcLang}:${this._params.dstLang}`
      ];
    return targetToken ? `${targetToken} ${input}` : input;
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
  ): Promise<TranslationResponse> {
    const text = this._prepareInputText(input);
    const response = this._createStandardResponse();
    this._job.startWith(response);

    try {
      await this.addon!.runJob({ type: "text", input: text });
    } catch (err) {
      this._job.fail(err as Error);
      throw err;
    }

    return response as unknown as TranslationResponse;
  }

  private async _runInternal(input: string): Promise<TranslationResponse> {
    if (!this.addon) {
      throw new Error("Model not loaded. Call load() first.");
    }
    if (this._modelType === TranslationNmtcpp.ModelTypes.IndicTrans) {
      return this._runIndicTrans(input);
    }
    return this._runStandardTranslation(input);
  }

  /**
   * Translates multiple texts in a single batch for better performance.
   * Serialized with `run()` through the same exclusive queue — the batch
   * holds the queue slot until its results are delivered.
   *
   * @param texts - Array of texts to translate
   * @returns Array of translated texts (same order as input)
   */
  async runBatch(texts: string[]): Promise<string[]> {
    return this._run(() => this._runBatchInternal(texts)) as Promise<string[]>;
  }

  private async _runBatchInternal(texts: string[]): Promise<string[]> {
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

    const response = this._job.start();

    const resultPromise = new Promise<string[]>((resolve, reject) => {
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

    try {
      await this.addon.runJob({ type: "sequences", input: processedTexts });
    } catch (err) {
      // Fails the active response; resultPromise rejects via its onError.
      this._job.fail(err as Error);
    }

    return resultPromise;
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
     * (libqvac-ggml-vulkan.so, etc.). Defaults to the host
     * `@qvac/fabric-<platform>` package's `prebuilds/` on desktop, falling
     * back to this package's `prebuilds/` on mobile where the package tree
     * isn't resolvable from the packed worklet.
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
   * Response returned by `run()`: the public `QvacResponse<string>` surface
   * plus typed access to `stats`. `stats` is `{}` until the run finishes and
   * is only populated when the model was constructed with `opts.stats = true`
   * (narrow with e.g. `'TPS' in response.stats`).
   */
  export type TranslationResponse = Omit<QvacResponse<string>, never> & {
    readonly stats: RuntimeStats | Record<string, never>;
  };
}

export = TranslationNmtcpp;
