"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
const path = require("bare-path");
const QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
const infer_base_1 = require("@qvac/infer-base");
const marian_1 = require("./marian");
const indic_processor_1 = require("./third-party/indic-processor");
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
     * Loads the model. If already loaded, unloads first.
     */
    async load() {
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
    async run(input) {
        return this._run(() => this._runInternal(input));
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
            otherConfig.backendsDir = path.join(__dirname, "prebuilds");
        }
        const configurationParams = {
            path: this._files.model,
            config: otherConfig,
        };
        this._configureBergamotModel(configurationParams);
        this.addon = new marian_1.TranslationInterface(configurationParams, this._addonOutputCallback.bind(this), this.logger);
        await this.addon.activate();
        this.state.configLoaded = true;
    }
    /**
     * Handles IndicTrans model translation
     */
    async _runIndicTrans(input) {
        const processor = new indic_processor_1.IndicProcessor();
        const [processedText] = processor.preprocessBatch([input], this._params.srcLang, this._params.dstLang);
        await this.addon.runJob({
            type: "text",
            input: processedText,
        });
        const response = new QvacIndicTransResponse(processor, this._params.dstLang, {
            cancelHandler: () => this.addon.cancel(),
        });
        return this._job.startWith(response);
    }
    /**
     * Prepares input text with language prefix if needed
     */
    _prepareInputText(input) {
        if (this._params.srcLang === "en" && this._params.dstLang === "pt") {
            return `>>por<< ${input}`;
        }
        return input;
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
        await this.addon.runJob({ type: "text", input: text });
        const response = this._createStandardResponse();
        return this._job.startWith(response);
    }
    async _runInternal(input) {
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
    async runBatch(texts) {
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
        await this.addon.runJob({ type: "sequences", input: processedTexts });
        const response = this._job.start();
        return new Promise((resolve, reject) => {
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
