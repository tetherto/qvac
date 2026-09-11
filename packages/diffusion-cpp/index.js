"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VideoStableDiffusion = exports.EsrganUpscaler = exports.ImgStableDiffusion = void 0;
exports.applyFluxImg2ImgDimDefaults = applyFluxImg2ImgDimDefaults;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
const path = require("bare-path");
const QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
const infer_base_1 = require("@qvac/infer-base");
const addon_1 = require("./addon");
const COMPANION_FILE_KEYS = [
    'clipL',
    'clipG',
    't5Xxl',
    'llm',
    'vae',
    'esrgan',
    'highNoiseDiffusionModel',
    'uncondModel'
];
const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed';
const NATIVE_UPSCALE_REPEATS_MAX = 2_147_483_647;
function assertAbsolute(key, value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`files.${key} must be an absolute path string`);
    }
    if (!path.isAbsolute(value)) {
        throw new TypeError(`files.${key} must be an absolute path (got: ${value})`);
    }
}
function coerceToUint8(name, value) {
    if (value instanceof Uint8Array)
        return value;
    if (ArrayBuffer.isView(value) && 'BYTES_PER_ELEMENT' in value && value.BYTES_PER_ELEMENT === 1) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (value instanceof ArrayBuffer ||
        (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
        return new Uint8Array(value);
    }
    throw new TypeError(`${name} must be a Uint8Array / Buffer / ArrayBuffer of PNG/JPEG bytes. ` +
        `Got: ${value === null ? 'null' : typeof value}`);
}
function normalizeUpscaleRepeats(options) {
    if (options == null)
        return 1;
    if (typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('upscale options must be an object');
    }
    const repeats = options.repeats == null ? 1 : options.repeats;
    if (!Number.isInteger(repeats) || repeats <= 0) {
        throw new TypeError('upscale.repeats must be a positive integer');
    }
    if (repeats > NATIVE_UPSCALE_REPEATS_MAX) {
        throw new RangeError('upscale.repeats must be a positive integer within the native int range');
    }
    return repeats;
}
function loggableError(error) {
    if (error && typeof error === 'object' && 'message' in error) {
        const message = error.message;
        return message || error;
    }
    return error;
}
/**
 * Text-to-image and image-to-image generation using stable-diffusion.cpp.
 * Supports SD1.x, SD2.x, SDXL, SD3, FLUX.2 [klein], and Ideogram 4.
 */
class ImgStableDiffusion {
    addon;
    opts;
    logger;
    state;
    _files;
    _config;
    _job;
    _run;
    _hasActiveResponse;
    constructor({ files, config, logger = null, opts = {} }) {
        if (!files || typeof files !== 'object') {
            throw new TypeError('files must be an object containing at least { model }');
        }
        assertAbsolute('model', files.model);
        for (const key of COMPANION_FILE_KEYS) {
            if (files[key] !== undefined) {
                assertAbsolute(key, files[key]);
            }
        }
        this._files = files;
        this._config = config || {};
        this.logger = new QvacLogger(logger);
        this.opts = opts;
        this._job = (0, infer_base_1.createJobHandler)({ cancel: () => this.addon?.cancel() });
        this._run = (0, infer_base_1.exclusiveRunQueue)();
        this.addon = null;
        this._hasActiveResponse = false;
        this.state = { configLoaded: false };
    }
    async load() {
        return this._run(async () => {
            if (this.state.configLoaded)
                return;
            await this._load();
            this.state.configLoaded = true;
        });
    }
    async _load() {
        this.logger.info('Starting stable-diffusion model load');
        const isSplitLayout = !!this._files.llm || !!this._files.t5Xxl || !!this._files.clipL || !!this._files.clipG;
        const filesWithClipVision = this._files;
        const configurationParams = {
            path: isSplitLayout ? '' : this._files.model,
            diffusionModelPath: isSplitLayout ? this._files.model : '',
            highNoiseDiffusionModelPath: this._files.highNoiseDiffusionModel || '',
            uncondDiffusionModelPath: this._files.uncondModel || '',
            clipLPath: this._files.clipL || '',
            clipGPath: this._files.clipG || '',
            t5XxlPath: this._files.t5Xxl || '',
            llmPath: this._files.llm || '',
            vaePath: this._files.vae || '',
            clipVisionPath: filesWithClipVision.clipVision || '',
            esrganPath: this._files.esrgan || '',
            audioVaePath: '',
            embeddingsConnectorsPath: '',
            config: this._config
        };
        this.logger.info('Creating stable-diffusion addon with configuration:', configurationParams);
        try {
            this.addon = this._createAddon(configurationParams);
            this.logger.info('Activating stable-diffusion addon');
            await this.addon.activate();
        }
        catch (loadError) {
            this.logger.error('Error during stable-diffusion model load:', loadError);
            try {
                await this.addon?.unload?.();
            }
            catch { }
            this.addon = null;
            throw loadError;
        }
        this.logger.info('Stable-diffusion model load completed successfully');
    }
    _createAddon(configurationParams) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
        const binding = require('./binding');
        return new addon_1.SdInterface(binding, configurationParams, this._addonOutputCallback.bind(this));
    }
    _addonOutputCallback(_addon, event, data, error) {
        const mapped = (0, addon_1.mapAddonEvent)(event, data, error);
        if (mapped === null) {
            this.logger.debug(`Unhandled addon event: ${String(event)} (data type: ${typeof data})`);
            return;
        }
        if (mapped.type === 'Error') {
            this.logger.error('Job failed with error:', mapped.error);
            this._job.fail(mapped.error);
            return;
        }
        if (mapped.type === 'JobEnded') {
            this._job.end(this.opts.stats ? mapped.data : null);
            return;
        }
        this._job.output(mapped.data);
    }
    async run(params) {
        return this._run(() => this._runInternal(params));
    }
    async _runInternal(originalParams) {
        let params = originalParams;
        const isSingleImage = params.init_image != null;
        const maybeInitImages = Array.isArray(params.init_images) && params.init_images.length > 0;
        const paramsWithPrediction = params;
        const predictionForDefaults = paramsWithPrediction.prediction || (this._config && this._config.prediction);
        if ((isSingleImage || maybeInitImages) && predictionForDefaults) {
            params = applyFluxImg2ImgDimDefaults(params, predictionForDefaults, maybeInitImages);
        }
        const alignTo = 8;
        const width = params.width;
        const height = params.height;
        const widthProvided = width != null;
        const heightProvided = height != null;
        const widthBad = widthProvided &&
            (typeof width !== 'number' || !Number.isFinite(width) || width <= 0 || width % alignTo !== 0);
        const heightBad = heightProvided &&
            (typeof height !== 'number' ||
                !Number.isFinite(height) ||
                height <= 0 ||
                height % alignTo !== 0);
        if (widthBad || heightBad) {
            const suggestedWidth = typeof width === 'number' && Number.isFinite(width) && width > 0
                ? Math.round(width / alignTo) * alignTo
                : 512;
            const suggestedHeight = typeof height === 'number' && Number.isFinite(height) && height > 0
                ? Math.round(height / alignTo) * alignTo
                : 512;
            throw new Error(`width and height must be positive multiples of ${alignTo}. ` +
                `Got: ${width}x${height}. ` +
                `Use ${suggestedWidth}x${suggestedHeight} instead.`);
        }
        if (typeof params.prompt !== 'string' || params.prompt.length === 0) {
            throw new TypeError(`params.prompt is required and must be a non-empty string. Got: ${typeof params.prompt}`);
        }
        if (params.init_images != null && !Array.isArray(params.init_images)) {
            throw new TypeError('init_images must be an Array of Uint8Array; got ' + typeof params.init_images);
        }
        const hasInitImages = Array.isArray(params.init_images) && params.init_images.length > 0;
        if (params.init_image != null && hasInitImages) {
            throw new Error('init_image and init_images are mutually exclusive — pick one. ' +
                'Use init_images (with FLUX.2) for multi-reference "fusion" mode, ' +
                'or init_image for single-image conditioning (SDEdit / FLUX.2 single-ref).');
        }
        if (params.init_image != null) {
            params.init_image = coerceToUint8('init_image', params.init_image);
        }
        if (params.init_images != null &&
            Array.isArray(params.init_images) &&
            params.init_images.length === 0) {
            throw new Error('init_images must not be an empty array. ' +
                'Pass at least one reference image or use init_image for single-image mode.');
        }
        if (hasInitImages && params.init_images) {
            for (let i = 0; i < params.init_images.length; i += 1) {
                let coerced;
                try {
                    coerced = coerceToUint8(`init_images[${i}]`, params.init_images[i]);
                }
                catch {
                    throw new TypeError(`init_images[${i}] must be a non-empty Uint8Array`);
                }
                if (coerced.length === 0) {
                    throw new TypeError(`init_images[${i}] must be a non-empty Uint8Array`);
                }
                params.init_images[i] = coerced;
            }
        }
        const prediction = this._config?.prediction;
        if (hasInitImages && params.init_images) {
            const isFlux2 = !!this._files?.llm && prediction === 'flux2_flow';
            if (!isFlux2) {
                throw new Error('init_images (multi-reference fusion) requires a FLUX.2 model. ' +
                    "Load a FLUX.2 [klein] checkpoint with files.llm set and pass config.prediction: 'flux2_flow'. " +
                    'Other architectures (SD1.x, SD2.x, SDXL, SD3, single-image FLUX.2) do not support ' +
                    '@image1/@imageN in-context references.');
            }
            if (params.increase_ref_index != null && typeof params.increase_ref_index !== 'boolean') {
                throw new Error('increase_ref_index must be a boolean. Got: ' + typeof params.increase_ref_index);
            }
            if (params.auto_resize_ref_image != null &&
                typeof params.auto_resize_ref_image !== 'boolean') {
                throw new Error('auto_resize_ref_image must be a boolean. Got: ' + typeof params.auto_resize_ref_image);
            }
            const prompt = typeof params.prompt === 'string' ? params.prompt : '';
            const mentioned = [];
            const missing = [];
            for (let i = 1; i <= params.init_images.length; i += 1) {
                const tag = `@image${i}`;
                if (prompt.includes(tag))
                    mentioned.push(tag);
                else
                    missing.push(tag);
            }
            if (mentioned.length === 0) {
                this.logger.warn('If multiple images have been selected, you need to check the prompt to see ' +
                    'if "@image1" and "@imageX" is mentioned at all so that the prompt makes sense. ' +
                    `None of @image1…@image${params.init_images.length} were found in the prompt ` +
                    '— FLUX2 will run but the references will have no effect.');
            }
            else if (missing.length > 0) {
                this.logger.warn(`Only ${mentioned.join(', ')} found in the prompt; ` +
                    `missing ${missing.join(', ')}. Those reference images will be ignored by FLUX2.`);
            }
            this.logger.info(`stable-diffusion: entering "fusion" mode — ${params.init_images.length} reference images ` +
                '(FLUX2 in-context conditioning via ref_images). ' +
                'Generation will attend to every referenced @imageN in the prompt.');
        }
        if (params.increase_ref_index != null && !hasInitImages) {
            throw new Error('increase_ref_index is only valid with init_images (multi-reference fusion). ' +
                'Your params do not include init_images.');
        }
        if (params.auto_resize_ref_image != null && !params.init_image && !hasInitImages) {
            throw new Error('auto_resize_ref_image can only be used with init_image or init_images. ' +
                'No reference images provided.');
        }
        if (params.lora != null) {
            if (typeof params.lora !== 'string' || params.lora.length === 0) {
                throw new TypeError('params.lora must be a non-empty string');
            }
            if (!path.isAbsolute(params.lora)) {
                throw new TypeError(`params.lora must be an absolute path (got: ${params.lora})`);
            }
        }
        if (params.upscale != null && params.upscale !== false && !this._files.esrgan) {
            throw new Error('ESRGAN upscale requested but files.esrgan was not provided');
        }
        if (params.init_image && this._files.llm) {
            if (prediction !== 'flux2_flow' && prediction !== 'flux_flow') {
                throw new Error('FLUX img2img requires an explicit prediction type in config. ' +
                    "Set prediction: 'flux2_flow' (FLUX.2). " +
                    'Without this the addon silently falls back to the SD/SDEdit img2img branch ' +
                    'instead of the FLUX in-context conditioning path.');
            }
        }
        if (!this.addon) {
            throw new Error('Addon not initialized. Call load() first.');
        }
        const mode = params.init_image || hasInitImages ? 'img2img' : 'txt2img';
        this.logger.info('Starting generation with mode:', mode);
        if (this._hasActiveResponse) {
            throw new Error(RUN_BUSY_ERROR_MESSAGE);
        }
        const response = this._job.start();
        let accepted;
        try {
            accepted = await this.addon.runJob({ ...params, mode });
        }
        catch (error) {
            this._job.fail(error);
            throw error;
        }
        if (!accepted) {
            this._job.fail(new Error(RUN_BUSY_ERROR_MESSAGE));
            throw new Error(RUN_BUSY_ERROR_MESSAGE);
        }
        this._hasActiveResponse = true;
        const finalized = response.await().finally(() => {
            this._hasActiveResponse = false;
        });
        finalized.catch((error) => {
            this.logger?.warn?.('Generation response rejected:', loggableError(error));
        });
        response.await = () => finalized;
        this.logger.info('Generation job started successfully');
        return response;
    }
    async cancel() {
        if (this.addon?.cancel) {
            await this.addon.cancel();
        }
    }
    async unload() {
        return this._run(async () => {
            await this.cancel();
            if (this._job.active) {
                this._job.fail(new Error('Model was unloaded'));
            }
            this._hasActiveResponse = false;
            if (this.addon) {
                await this.addon.unload();
                this.addon = null;
            }
            this.state.configLoaded = false;
        });
    }
    getState() {
        return this.state;
    }
}
exports.ImgStableDiffusion = ImgStableDiffusion;
/**
 * Standalone ESRGAN image upscaling using stable-diffusion.cpp.
 * Accepts encoded PNG/JPEG bytes and emits PNG bytes.
 */
class EsrganUpscaler {
    opts;
    logger;
    state;
    _files;
    _config;
    _job;
    _run;
    addon;
    _hasActiveResponse;
    constructor({ files, config, logger = null, opts = {} }) {
        if (!files || typeof files !== 'object') {
            throw new TypeError('files must be an object containing { esrgan }');
        }
        assertAbsolute('esrgan', files.esrgan);
        this._files = files;
        this._config = config || {};
        this.logger = new QvacLogger(logger);
        this.opts = opts;
        this._job = (0, infer_base_1.createJobHandler)({ cancel: () => this.addon?.cancel() });
        this._run = (0, infer_base_1.exclusiveRunQueue)();
        this.addon = null;
        this._hasActiveResponse = false;
        this.state = { configLoaded: false };
    }
    async load() {
        return this._run(async () => {
            if (this.state.configLoaded)
                return;
            await this._load();
            this.state.configLoaded = true;
        });
    }
    async _load() {
        this.logger.info('Starting ESRGAN upscaler load');
        const configurationParams = {
            esrganPath: this._files.esrgan,
            config: this._config
        };
        this.logger.info('Creating ESRGAN upscaler addon with configuration:', configurationParams);
        try {
            this.addon = this._createAddon(configurationParams);
            this.logger.info('Activating ESRGAN upscaler addon');
            await this.addon.activate();
        }
        catch (loadError) {
            this.logger.error('Error during ESRGAN upscaler load:', loadError);
            try {
                await this.addon?.unload?.();
            }
            catch { }
            this.addon = null;
            throw loadError;
        }
        this.logger.info('ESRGAN upscaler load completed successfully');
    }
    _createAddon(configurationParams) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
        const binding = require('./binding');
        return new addon_1.EsrganUpscalerInterface(binding, configurationParams, this._addonOutputCallback.bind(this));
    }
    _addonOutputCallback(_addon, event, data, error) {
        const mapped = (0, addon_1.mapAddonEvent)(event, data, error);
        if (mapped === null) {
            this.logger.debug(`Unhandled addon event: ${String(event)} (data type: ${typeof data})`);
            return;
        }
        if (mapped.type === 'Error') {
            this.logger.error('ESRGAN upscale failed with error:', mapped.error);
            this._job.fail(mapped.error);
            return;
        }
        if (mapped.type === 'JobEnded') {
            this._job.end(this.opts.stats ? mapped.data : null);
            return;
        }
        this._job.output(mapped.data);
    }
    async upscale(imageBytes, options) {
        return this._run(() => this._upscaleInternal(imageBytes, options));
    }
    async _upscaleInternal(imageBytes, options) {
        if (!(imageBytes instanceof Uint8Array)) {
            throw new TypeError('input image must be a Uint8Array');
        }
        const repeats = normalizeUpscaleRepeats(options);
        if (!this.addon) {
            throw new Error('Addon not initialized. Call load() first.');
        }
        if (this._hasActiveResponse) {
            throw new Error(RUN_BUSY_ERROR_MESSAGE);
        }
        const response = this._job.start();
        let accepted;
        try {
            accepted = await this.addon.runJob(imageBytes, { repeats });
        }
        catch (error) {
            this._job.fail(error);
            throw error;
        }
        if (!accepted) {
            this._job.fail(new Error(RUN_BUSY_ERROR_MESSAGE));
            throw new Error(RUN_BUSY_ERROR_MESSAGE);
        }
        this._hasActiveResponse = true;
        const finalized = response.await().finally(() => {
            this._hasActiveResponse = false;
        });
        finalized.catch((error) => {
            this.logger?.warn?.('ESRGAN upscale response rejected:', loggableError(error));
        });
        response.await = () => finalized;
        this.logger.info('ESRGAN upscale job started successfully');
        return response;
    }
    async cancel() {
        if (this.addon?.cancel) {
            await this.addon.cancel();
        }
    }
    async unload() {
        return this._run(async () => {
            await this.cancel();
            if (this._job.active) {
                this._job.fail(new Error('Upscaler was unloaded'));
            }
            this._hasActiveResponse = false;
            if (this.addon) {
                await this.addon.unload();
                this.addon = null;
            }
            this.state.configLoaded = false;
        });
    }
    getState() {
        return this.state;
    }
}
exports.EsrganUpscaler = EsrganUpscaler;
function applyFluxImg2ImgDimDefaults(params, prediction, hasInitImages) {
    void hasInitImages;
    const isFlux = prediction === 'flux_flow' || prediction === 'flux2_flow';
    if (!isFlux) {
        return params;
    }
    if (params.width !== undefined && params.height !== undefined) {
        return params;
    }
    return {
        ...params,
        width: params.width !== undefined ? params.width : 1024,
        height: params.height !== undefined ? params.height : 1024
    };
}
// eslint-disable-next-line @typescript-eslint/no-require-imports -- preserve the CommonJS video subpath export.
exports.VideoStableDiffusion = require('./video');
exports.default = ImgStableDiffusion;
const cjsExports = ImgStableDiffusion;
cjsExports.ImgStableDiffusion = ImgStableDiffusion;
cjsExports.VideoStableDiffusion = exports.VideoStableDiffusion;
cjsExports.EsrganUpscaler = EsrganUpscaler;
cjsExports.applyFluxImg2ImgDimDefaults = applyFluxImg2ImgDimDefaults;
module.exports = cjsExports;
