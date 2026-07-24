"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
const path = require("bare-path");
const QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
const infer_base_1 = require("@qvac/infer-base");
const addon_1 = require("./addon");
const COMPANION_FILE_KEYS = [
    'highNoiseDiffusionModel',
    't5Xxl',
    'vae',
    'clipVision',
    'esrgan',
    'llm',
    'audioVae',
    'embeddingsConnectors'
];
const VIDEO_MODES = new Set(['txt2vid', 'img2vid']);
const WAN22_MOE_PARAMS = [
    'high_noise_steps',
    'high_noise_sampler',
    'high_noise_scheduler',
    'high_noise_cfg_scale',
    'high_noise_flow_shift',
    'moe_boundary'
];
const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed';
function assertAbsolute(key, value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`files.${key} must be an absolute path string`);
    }
    if (!path.isAbsolute(value)) {
        throw new TypeError(`files.${key} must be an absolute path (got: ${value})`);
    }
}
function validateVideoFrames(frameCount, isLtx = false) {
    const factor = isLtx ? 8 : 4;
    const minimum = factor + 1;
    if (!Number.isInteger(frameCount)) {
        throw new Error(`video_frames must be an integer of the form (${factor}*k + 1) with k >= 1. Got: ${frameCount}`);
    }
    if (isLtx) {
        if (frameCount < minimum || (frameCount - 1) % 8 !== 0 || frameCount > 257) {
            throw new Error('LTX-2 video_frames must be an integer of the form (8*k + 1) in ' +
                `[9, 257] (9, 17, 25, 33, ..., 257). Got: ${frameCount}`);
        }
        return;
    }
    if (frameCount < 5 || (frameCount - 1) % 4 !== 0) {
        throw new Error('video_frames must be an integer >= 5 of the form (4*k + 1). ' +
            'Valid values: 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49, 53, ' +
            '57, 61, 65, 69, 73, 77, 81 (Wan 1.3B native training length). ' +
            `Got: ${frameCount}`);
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
function peekImageDims(buf) {
    if (!buf || buf.length < 8)
        return null;
    if (buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47 &&
        buf[4] === 0x0d &&
        buf[5] === 0x0a &&
        buf[6] === 0x1a &&
        buf[7] === 0x0a) {
        if (buf.length < 24)
            return null;
        const w = ((buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19]) >>> 0;
        const h = ((buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23]) >>> 0;
        return { w, h };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
        let i = 2;
        while (i + 3 < buf.length) {
            if (buf[i] !== 0xff)
                break;
            const marker = buf[i + 1];
            if (marker === 0xd9 || marker === 0xda)
                break;
            const segmentLength = (buf[i + 2] << 8) | buf[i + 3];
            if (marker >= 0xc0 && marker <= 0xc3) {
                if (buf.length >= i + 9) {
                    const h = (buf[i + 5] << 8) | buf[i + 6];
                    const w = (buf[i + 7] << 8) | buf[i + 8];
                    return { w, h };
                }
                break;
            }
            i += 2 + segmentLength;
        }
    }
    return null;
}
function loggableError(error) {
    if (error && typeof error === 'object' && 'message' in error) {
        const message = error.message;
        return message || error;
    }
    return error;
}
/**
 * Text-to-video and image-to-video generation using stable-diffusion.cpp's
 * `generate_video()` path.
 */
class VideoStableDiffusion {
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
        const upscalerKeys = Object.keys(this._config).filter((key) => key.startsWith('upscaler_'));
        if (upscalerKeys.length > 0) {
            this.logger.warn(`${upscalerKeys.join(', ')} provided in config but ESRGAN upscale ` +
                'is image-only -- VideoStableDiffusion will ignore these keys.');
        }
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
        this.logger.info('Starting Wan video model load');
        const configurationParams = {
            path: '',
            diffusionModelPath: this._files.model,
            highNoiseDiffusionModelPath: this._files.highNoiseDiffusionModel || '',
            uncondDiffusionModelPath: '',
            clipLPath: '',
            clipGPath: '',
            t5XxlPath: this._files.t5Xxl || '',
            llmPath: this._files.llm || '',
            vaePath: this._files.vae || '',
            clipVisionPath: this._files.clipVision || '',
            esrganPath: this._files.esrgan || '',
            audioVaePath: this._files.audioVae || '',
            embeddingsConnectorsPath: this._files.embeddingsConnectors || '',
            config: this._config
        };
        this.logger.info('Creating stable-diffusion addon (video mode) with configuration:', configurationParams);
        try {
            this.addon = this._createAddon(configurationParams);
            this.logger.info('Activating stable-diffusion addon (video mode)');
            await this.addon.activate();
        }
        catch (loadError) {
            this.logger.error('Error during Wan video model load:', loadError);
            try {
                await this.addon?.unload?.();
            }
            catch { }
            this.addon = null;
            throw loadError;
        }
        this.logger.info('Wan video model load completed successfully');
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
    async _runInternal(inputParams) {
        if (!inputParams || typeof inputParams !== 'object') {
            throw new TypeError('run(params): params must be an object');
        }
        const params = inputParams;
        if (typeof params.prompt !== 'string' || params.prompt.length === 0) {
            throw new TypeError(`params.prompt is required and must be a non-empty string. Got: ${typeof params.prompt}`);
        }
        if (typeof params.mode !== 'string' || !VIDEO_MODES.has(params.mode)) {
            throw new Error('VideoStableDiffusion.run: params.mode is required and must be one of ' +
                `'txt2vid' | 'img2vid'. Got: ${JSON.stringify(params.mode)}`);
        }
        const { mode } = params;
        const dimensionsImplicit = params.width == null && params.height == null;
        const isLtx = this._isLtx();
        const alignTo = isLtx ? 32 : 16;
        const width = params.width;
        const height = params.height;
        const widthBad = width != null &&
            (typeof width !== 'number' || !Number.isFinite(width) || width <= 0 || width % alignTo !== 0);
        const heightBad = height != null &&
            (typeof height !== 'number' ||
                !Number.isFinite(height) ||
                height <= 0 ||
                height % alignTo !== 0);
        if (widthBad || heightBad) {
            const suggestedWidth = typeof width === 'number' && Number.isFinite(width) && width > 0
                ? Math.round(width / alignTo) * alignTo
                : isLtx
                    ? 768
                    : 480;
            const suggestedHeight = typeof height === 'number' && Number.isFinite(height) && height > 0
                ? Math.round(height / alignTo) * alignTo
                : isLtx
                    ? 512
                    : 832;
            throw new Error(`width and height must be positive multiples of ${alignTo}. ` +
                `Got: ${width}x${height}. Use ${suggestedWidth}x${suggestedHeight} instead.`);
        }
        if (params.video_frames != null) {
            validateVideoFrames(params.video_frames, isLtx);
        }
        if (params.fps != null &&
            (!Number.isFinite(params.fps) || params.fps <= 0 || params.fps > 120)) {
            throw new RangeError(`fps must be in (0, 120]. Got: ${params.fps}`);
        }
        if (params.moe_boundary != null) {
            const boundary = params.moe_boundary;
            if (!Number.isFinite(boundary) || boundary < 0 || boundary > 1) {
                throw new RangeError(`moe_boundary must be in [0, 1]. Got: ${boundary}`);
            }
        }
        if (params.init_image != null) {
            params.init_image = coerceToUint8('init_image', params.init_image);
            if (params.init_image.length === 0) {
                throw new Error('init_image must not be empty');
            }
            if (dimensionsImplicit) {
                const dimensions = peekImageDims(params.init_image);
                if (dimensions && (dimensions.w % alignTo !== 0 || dimensions.h % alignTo !== 0)) {
                    throw new Error(`init_image dimensions ${dimensions.w}x${dimensions.h} must be multiples of ${alignTo}. ` +
                        'Pass explicit width/height to override or pre-scale the image.');
                }
            }
        }
        if (params.init_images != null) {
            throw new Error('VideoStableDiffusion does not accept init_images (FLUX fusion is ' +
                'image-only). Use init_image or control_frames for VACE guidance.');
        }
        if (mode === 'txt2vid') {
            if (params.init_image != null) {
                throw new Error("txt2vid does not accept init_image. Use mode='img2vid' instead.");
            }
        }
        else if (!(params.init_image instanceof Uint8Array)) {
            throw new Error('img2vid requires init_image (Uint8Array / Buffer / ArrayBuffer of PNG/JPEG bytes).');
        }
        if (params.control_frames != null) {
            if (!Array.isArray(params.control_frames)) {
                throw new TypeError('control_frames must be an Array of Uint8Array. ' + `Got: ${typeof params.control_frames}`);
            }
            if (params.control_frames.length === 0) {
                throw new Error('control_frames must not be an empty array. Omit the field ' +
                    'entirely to skip VACE guidance.');
            }
            for (let i = 0; i < params.control_frames.length; i += 1) {
                let coerced;
                try {
                    coerced = coerceToUint8(`control_frames[${i}]`, params.control_frames[i]);
                }
                catch {
                    throw new TypeError(`control_frames[${i}] must be a non-empty Uint8Array`);
                }
                if (coerced.length === 0) {
                    throw new TypeError(`control_frames[${i}] must be a non-empty Uint8Array`);
                }
                params.control_frames[i] = coerced;
            }
            if (dimensionsImplicit) {
                for (let i = 0; i < params.control_frames.length; i += 1) {
                    const dimensions = peekImageDims(params.control_frames[i]);
                    if (dimensions && (dimensions.w % alignTo !== 0 || dimensions.h % alignTo !== 0)) {
                        throw new Error(`control_frames[${i}] dimensions ${dimensions.w}x${dimensions.h} must be multiples of ${alignTo}. ` +
                            'Pass explicit width/height to override or pre-scale the frame.');
                    }
                }
            }
        }
        if (params.vace_strength != null &&
            (!Array.isArray(params.control_frames) || params.control_frames.length === 0)) {
            this.logger.warn('vace_strength was set but control_frames is not provided — ' +
                'vace_strength will have no effect.');
        }
        if (mode === 'img2vid' && !isLtx && !this._files.clipVision) {
            throw new TypeError(`mode='${mode}' requires files.clipVision (OpenCLIP ViT-H/14). ` +
                'Download clip_vision_h.safetensors from ' +
                'Comfy-Org/Wan_2.1_ComfyUI_repackaged and pass its absolute path as ' +
                'files.clipVision.');
        }
        if (!this._files.highNoiseDiffusionModel) {
            const used = WAN22_MOE_PARAMS.filter((key) => params[key] != null);
            if (used.length > 0) {
                throw new Error(`${used.join(', ')} requires files.highNoiseDiffusionModel. ` +
                    'These parameters are only supported by Wan 2.2 T2V-A14B MoE models.');
            }
        }
        if (params.lora != null) {
            throw new Error('params.lora is not supported for video generation yet. ' +
                'Video generation uses distinct diffusion and expert components ' +
                'that do not yet support LoRA injection.');
        }
        if (!this.addon) {
            throw new Error('Addon not initialized. Call load() first.');
        }
        this.logger.info(`Starting video generation with mode: ${mode}`);
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
            this.logger?.warn?.('Video generation response rejected:', loggableError(error));
        });
        response.await = () => finalized;
        this.logger.info('Video generation job started successfully');
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
    _isLtx() {
        return !!this._files.embeddingsConnectors;
    }
}
exports.default = VideoStableDiffusion;
module.exports = VideoStableDiffusion;
