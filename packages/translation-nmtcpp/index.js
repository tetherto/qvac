"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
const path = require("bare-path");
const fs = require("bare-fs");
const QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
const infer_base_1 = require("@qvac/infer-base");
const marian_1 = require("./marian");
const indic_processor_1 = require("./third-party/indic-processor");
/**
 * Opus-MT-style target-language tokens prepended to the source text for
 * specific Bergamot language pairs. The Firefox Translations en→pt model is a
 * multi-variant export that expects an explicit `>>por<<` token selecting
 * Portuguese output; without it the model can mistranslate or echo a variant
 * token. The output side strips any echoed `>>xxx<<` token (see
 * `_createStandardResponse`). Keyed by `"srcLang:dstLang"`.
 */
const BERGAMOT_TARGET_TOKEN_BY_PAIR = {
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
function resolveBackendsDir() {
    try {
        const fabricPkg = require.resolve("@qvac/fabric/package");
        const fabricPrebuilds = path.join(path.dirname(fabricPkg), "prebuilds");
        if (fs.existsSync(fabricPrebuilds))
            return fabricPrebuilds;
    }
    catch {
        // Mobile worklets cannot resolve the @qvac/fabric package tree.
    }
    return path.join(__dirname, "prebuilds");
}
class QvacIndicTransResponse extends infer_base_1.QvacResponse {
    processor;
    dstLang;
    /**
     * Creates an instance of QvacIndicTransResponse.
     */
    constructor(processor, dstLang, handlers) {
        super(handlers);
        this.processor = processor;
        this.dstLang = dstLang;
    }
    onCancel(callback) {
        return super.onCancel(callback);
    }
    onError(callback) {
        return super.onError(callback);
    }
    onFinish(callback) {
        return super.onFinish(callback);
    }
    onUpdate(callback) {
        return super.onUpdate((data) => {
            const [postProcessedText] = this.processor.postprocessBatch([data], this.dstLang);
            return callback(postProcessedText);
        });
    }
    async *iterate() {
        for await (const output of super.iterate()) {
            const [postProcessedText] = this.processor.postprocessBatch([output], this.dstLang);
            yield postProcessedText;
        }
    }
}
/**
 * TranslationNmtcpp implementation for Marian/IndicTrans/Bergamot translation models
 */
const TranslationNmtcpp = class TranslationNmtcpp {
    /**
     * Available model types for translation
     */
    static ModelTypes = {
        IndicTrans: "IndicTrans",
        Bergamot: "Bergamot",
    };
    opts;
    logger;
    addon;
    state;
    _modelType;
    _files;
    _config;
    _params;
    _pivotConfig;
    _job;
    _run;
    /**
     * Creates an instance of TranslationNmtcpp.
     */
    constructor({ files, params, config = {}, logger = null, opts = {}, }) {
        this.opts = opts;
        this.logger = new QvacLogger(logger);
        this.addon = null;
        this.state = {
            configLoaded: false,
            weightsLoaded: false,
            destroyed: false,
        };
        const { modelType, pivotConfig, ...additionalConfig } = config;
        this._modelType = modelType;
        if (this._modelType === "Opus") {
            throw new Error("ModelTypes.Opus has been deprecated. Use ModelTypes.Bergamot instead. " +
                "Bergamot covers European language pairs and supports pivot translation for non-English pairs via PivotTranslationModel.");
        }
        this._files = files;
        this._config = additionalConfig;
        this._params = params;
        this._pivotConfig = pivotConfig || {};
        this._job = (0, infer_base_1.createJobHandler)({ cancel: () => this.addon.cancel() });
        this._run = (0, infer_base_1.exclusiveRunQueue)();
    }
    /**
     * Returns the current state of the inference client.
     */
    getState() {
        return this.state;
    }
    /**
     * Loads the model. If already loaded, unloads first. Rejects after
     * `destroy()` — destruction is permanent; create a new instance instead.
     */
    async load() {
        if (this.state.destroyed) {
            throw new Error("Model has been destroyed. Create a new instance to load again.");
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
    async run(input) {
        return new Promise((resolve, reject) => {
            void this._run(async () => {
                let response;
                try {
                    response = await this._runInternal(input);
                }
                catch (err) {
                    reject(err instanceof Error ? err : new Error((0, marian_1.errorMessage)(err)));
                    return;
                }
                resolve(response);
                await response.await().catch(() => { });
            });
        });
    }
    /**
     * Unloads the model and frees resources.
     */
    async unload() {
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
    async destroy() {
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
    getActiveBackendName() {
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
    getActiveBackendDescription() {
        if (!this.addon) {
            return "";
        }
        return this.addon.getActiveBackendDescription();
    }
    /**
     * Checks if this is a Bergamot model
     */
    _isBergamotModel() {
        return this._modelType === TranslationNmtcpp.ModelTypes.Bergamot;
    }
    /**
     * Configures Bergamot-specific parameters
     */
    _configureBergamotModel(configurationParams) {
        if (!this._isBergamotModel())
            return;
        const vocabConfig = {};
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
            const pivotConfig = {
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
    _createAddon(configurationParams) {
        return new marian_1.TranslationInterface(configurationParams, this._addonOutputCallback.bind(this), this.logger);
    }
    async _load() {
        const otherConfig = { ...this._config };
        // Accept camelCase aliases for the GPU keys so the config object can
        // stay consistent with backendsDir/openclCacheDir. The C++ binding
        // expects snake_case (mirrors nmt_context_params field names), so we
        // translate camelCase → snake_case here. snake_case takes precedence
        // when both are present (explicit user choice wins over alias).
        if (otherConfig.use_gpu === undefined && otherConfig.useGPU !== undefined) {
            otherConfig.use_gpu = otherConfig.useGPU;
        }
        if (otherConfig.gpu_backend === undefined &&
            otherConfig.gpuBackend !== undefined) {
            otherConfig.gpu_backend = otherConfig.gpuBackend;
        }
        if (otherConfig.gpu_device === undefined &&
            otherConfig.gpuDevice !== undefined) {
            otherConfig.gpu_device = otherConfig.gpuDevice;
        }
        if (otherConfig.op_offload_min_batch === undefined &&
            otherConfig.opOffloadMinBatch !== undefined) {
            otherConfig.op_offload_min_batch = otherConfig.opOffloadMinBatch;
        }
        delete otherConfig.useGPU;
        delete otherConfig.gpuBackend;
        delete otherConfig.gpuDevice;
        delete otherConfig.opOffloadMinBatch;
        if (otherConfig.backendsDir === undefined) {
            otherConfig.backendsDir = resolveBackendsDir();
        }
        const configurationParams = {
            path: this._files.model,
            config: otherConfig,
        };
        this._configureBergamotModel(configurationParams);
        this.addon = this._createAddon(configurationParams);
        try {
            await this.addon.activate();
        }
        catch (err) {
            // A failed activation must not leak the native instance or keep the
            // global C++ → JS logger bridge registered; destroy() releases both.
            try {
                await this.addon.destroy();
            }
            catch (cleanupErr) {
                this.logger.warn("translation-nmtcpp: cleanup after failed activation failed: " +
                    (0, marian_1.errorMessage)(cleanupErr));
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
    async _runIndicTrans(input) {
        const processor = new indic_processor_1.IndicProcessor();
        const [processedText] = processor.preprocessBatch([input], this._params.srcLang, this._params.dstLang);
        const response = new QvacIndicTransResponse(processor, this._params.dstLang, {
            cancelHandler: () => this.addon.cancel(),
        });
        this._job.startWith(response);
        try {
            await this.addon.runJob({
                type: "text",
                input: processedText,
            });
        }
        catch (err) {
            this._job.fail(err);
            throw err;
        }
        return response;
    }
    /**
     * Prepends the Opus-MT-style target-language token when the active
     * language pair requires one (see BERGAMOT_TARGET_TOKEN_BY_PAIR).
     */
    _prepareInputText(input) {
        const targetToken = BERGAMOT_TARGET_TOKEN_BY_PAIR[`${this._params.srcLang}:${this._params.dstLang}`];
        return targetToken ? `${targetToken} ${input}` : input;
    }
    /**
     * Creates a response with output post-processing for language prefixes
     */
    _createStandardResponse() {
        const response = new infer_base_1.QvacResponse({
            cancelHandler: () => this.addon.cancel(),
        });
        const originalOnUpdate = response.onUpdate.bind(response);
        response.onUpdate = function (callback) {
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
    async _runStandardTranslation(input) {
        const text = this._prepareInputText(input);
        const response = this._createStandardResponse();
        this._job.startWith(response);
        try {
            await this.addon.runJob({ type: "text", input: text });
        }
        catch (err) {
            this._job.fail(err);
            throw err;
        }
        return response;
    }
    async _runInternal(input) {
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
    async runBatch(texts) {
        return this._run(() => this._runBatchInternal(texts));
    }
    async _runBatchInternal(texts) {
        if (!this.addon) {
            throw new Error("Model not loaded. Call load() first.");
        }
        if (!Array.isArray(texts)) {
            throw new Error("Input must be an array of strings");
        }
        let processedTexts = texts;
        let processor = null;
        if (this._modelType === TranslationNmtcpp.ModelTypes.IndicTrans) {
            processor = new indic_processor_1.IndicProcessor();
            processedTexts = processor.preprocessBatch(texts, this._params.srcLang, this._params.dstLang);
        }
        else {
            processedTexts = texts.map((text) => this._prepareInputText(text));
        }
        const response = this._job.start();
        const resultPromise = new Promise((resolve, reject) => {
            response
                .onFinish((result) => {
                const [batchResults] = result;
                if (this._modelType === TranslationNmtcpp.ModelTypes.IndicTrans &&
                    processor) {
                    resolve(processor.postprocessBatch(batchResults, this._params.dstLang));
                }
                else {
                    const cleanedResults = batchResults.map((text) => text.replace(/^>>[a-z]+\s*<<\s*/i, ""));
                    resolve(cleanedResults);
                }
            })
                .onError((error) => {
                reject(error);
            });
        });
        try {
            await this.addon.runJob({ type: "sequences", input: processedTexts });
        }
        catch (err) {
            // Fails the active response; resultPromise rejects via its onError.
            this._job.fail(err);
        }
        return resultPromise;
    }
    _addonOutputCallback(_addon, event, data, error) {
        const isStatsObject = typeof data === "object" &&
            data !== null &&
            !Array.isArray(data) &&
            Object.keys(data).some((k) => k.endsWith("TPS"));
        if (isStatsObject) {
            this._job.end(this.opts?.stats ? data : null);
            return;
        }
        if (event.includes("Error")) {
            this._job.fail(error);
            return;
        }
        if (typeof data === "string" || Array.isArray(data)) {
            this._job.output(data);
        }
    }
};
module.exports = TranslationNmtcpp;
