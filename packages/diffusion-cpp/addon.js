"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EsrganUpscalerInterface = exports.SdInterface = void 0;
exports.mapAddonEvent = mapAddonEvent;
exports.readImageDimensions = readImageDimensions;
/* eslint-disable @typescript-eslint/no-require-imports -- bare-path exposes a CommonJS export shape. */
const path = require("bare-path");
/**
 * Normalize a raw native event into `Output` (image bytes or progress
 * tick), `Error`, or `JobEnded`. Returns `null` for unknown shapes
 * (caller logs and skips).
 *
 * Classification priority:
 *   1. Error if rawEvent (string) includes substring "Error"
 *   2. Output if rawData is Uint8Array or string (binary or JSON)
 *   3. JobEnded if rawData is a truthy object (stats payload)
 *   4. Unknown (null) for anything else
 */
function mapAddonEvent(rawEvent, rawData, rawError) {
    if (typeof rawEvent === 'string' && rawEvent.includes('Error')) {
        return { type: 'Error', data: rawData, error: rawError };
    }
    if (rawData instanceof Uint8Array || typeof rawData === 'string') {
        return { type: 'Output', data: rawData, error: null };
    }
    if (rawData && typeof rawData === 'object' && !ArrayBuffer.isView(rawData)) {
        const data = {
            ...rawData
        };
        if (typeof data.backendDevice === 'number') {
            if (data.backendDevice === 0) {
                data.backendDevice = 'cpu';
            }
            else if (data.backendDevice === 1) {
                data.backendDevice = 'gpu';
            }
        }
        return { type: 'JobEnded', data, error: null };
    }
    return null;
}
/**
 * Extract pixel dimensions from a PNG or JPEG buffer without a full decode.
 *
 * PNG: width/height are stored as big-endian uint32 at bytes 16–23 of the IHDR chunk.
 * JPEG: scan for the first SOFx segment (0xFFCx) which stores height at +5 and width at +7.
 *
 * Returns `{ width, height }` or `null` if the format is not recognised.
 */
function readImageDimensions(buf) {
    if (!buf || buf.length < 4)
        return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        if (buf.length < 24)
            return null;
        const width = ((buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19]) >>> 0;
        const height = ((buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23]) >>> 0;
        return { width, height };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
        let i = 2;
        while (i + 4 < buf.length) {
            if (buf[i] !== 0xff)
                break;
            const marker = buf[i + 1];
            const segmentLength = (buf[i + 2] << 8) | buf[i + 3];
            if (segmentLength < 2)
                break;
            if ((marker >= 0xc0 && marker <= 0xc3) ||
                (marker >= 0xc5 && marker <= 0xc7) ||
                (marker >= 0xc9 && marker <= 0xcb) ||
                (marker >= 0xcd && marker <= 0xcf)) {
                if (i + 8 >= buf.length)
                    return null;
                const height = (buf[i + 5] << 8) | buf[i + 6];
                const width = (buf[i + 7] << 8) | buf[i + 8];
                return { width, height };
            }
            i += 2 + segmentLength;
        }
    }
    return null;
}
/**
 * JavaScript wrapper around the native stable-diffusion.cpp addon.
 * Manages the native handle lifecycle and bridges JS ↔ C++.
 */
class SdInterface {
    _binding;
    _handle;
    _spatialAlign;
    constructor(binding, configurationParams, outputCallback) {
        this._binding = binding;
        this._spatialAlign = configurationParams.embeddingsConnectorsPath ? 32 : 16;
        if (!configurationParams.config) {
            configurationParams.config = {};
        }
        if (!configurationParams.config.backendsDir) {
            configurationParams.config.backendsDir = path.join(__dirname, 'prebuilds');
        }
        configurationParams.config = Object.fromEntries(Object.entries(configurationParams.config)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)]));
        this._handle = this._binding.createInstance(this, configurationParams, outputCallback);
    }
    // eslint-disable-next-line @typescript-eslint/require-await -- preserve the original async wrapper semantics.
    async activate() {
        this._binding.activate(this._handle);
    }
    async cancel() {
        if (!this._handle)
            return;
        await this._binding.cancel(this._handle);
    }
    async runJob(rawParams) {
        const params = rawParams;
        if (params.init_image && Array.isArray(params.init_images) && params.init_images.length > 0) {
            throw new Error('addon.runJob: init_image and init_images are mutually exclusive — pick one.');
        }
        const controlFramesBuffers = Array.isArray(params.control_frames) ? params.control_frames : null;
        if (Array.isArray(params.init_images) && params.init_images.length > 0) {
            const initImageBuffers = params.init_images;
            const serializable = { ...params };
            delete serializable.init_images;
            delete serializable.control_frames;
            this._fillDimsFromImage(serializable, initImageBuffers[0]);
            const jobArgs = {
                type: 'text',
                input: JSON.stringify(serializable),
                initImageBuffers
            };
            if (controlFramesBuffers) {
                jobArgs.controlFramesBuffers = controlFramesBuffers;
            }
            return this._binding.runJob(this._handle, jobArgs);
        }
        if (params.init_image) {
            const initImageBuffer = params.init_image;
            const serializable = { ...params };
            delete serializable.init_image;
            delete serializable.control_frames;
            this._fillDimsFromImage(serializable, initImageBuffer);
            const jobArgs = {
                type: 'text',
                input: JSON.stringify(serializable),
                initImageBuffer
            };
            if (controlFramesBuffers) {
                jobArgs.controlFramesBuffers = controlFramesBuffers;
            }
            return this._binding.runJob(this._handle, jobArgs);
        }
        const serializable = { ...params };
        delete serializable.control_frames;
        const jobArgs = {
            type: 'text',
            input: JSON.stringify(serializable)
        };
        if (controlFramesBuffers) {
            jobArgs.controlFramesBuffers = controlFramesBuffers;
        }
        return this._binding.runJob(this._handle, jobArgs);
    }
    _fillDimsFromImage(params, buf) {
        if (params.width && params.height)
            return;
        const dimensions = readImageDimensions(buf);
        if (!dimensions)
            return;
        if (!params.width) {
            params.width = Math.ceil(dimensions.width / this._spatialAlign) * this._spatialAlign;
        }
        if (!params.height) {
            params.height = Math.ceil(dimensions.height / this._spatialAlign) * this._spatialAlign;
        }
    }
    // eslint-disable-next-line @typescript-eslint/require-await -- preserve the original async wrapper semantics.
    async unload() {
        if (!this._handle)
            return;
        this._binding.destroyInstance(this._handle);
        this._handle = null;
    }
}
exports.SdInterface = SdInterface;
class EsrganUpscalerInterface {
    _binding;
    _handle;
    constructor(binding, configurationParams, outputCallback) {
        this._binding = binding;
        if (!configurationParams.config) {
            configurationParams.config = {};
        }
        if (!configurationParams.config.backendsDir) {
            configurationParams.config.backendsDir = path.join(__dirname, 'prebuilds');
        }
        configurationParams.config = Object.fromEntries(Object.entries(configurationParams.config)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)]));
        this._handle = this._binding.createUpscalerInstance(this, configurationParams, outputCallback);
    }
    // eslint-disable-next-line @typescript-eslint/require-await -- preserve the original async wrapper semantics.
    async activate() {
        this._binding.activateUpscaler(this._handle);
    }
    async cancel() {
        if (!this._handle)
            return;
        await this._binding.cancel(this._handle);
    }
    async runJob(imageBytes, params) {
        return this._binding.runUpscaleJob(this._handle, {
            type: 'image',
            input: imageBytes,
            params: JSON.stringify(params || {})
        });
    }
    // eslint-disable-next-line @typescript-eslint/require-await -- preserve the original async wrapper semantics.
    async unload() {
        if (!this._handle)
            return;
        this._binding.destroyInstance(this._handle);
        this._handle = null;
    }
}
exports.EsrganUpscalerInterface = EsrganUpscalerInterface;
const cjsExports = {
    SdInterface,
    EsrganUpscalerInterface,
    mapAddonEvent,
    readImageDimensions
};
module.exports = cjsExports;
