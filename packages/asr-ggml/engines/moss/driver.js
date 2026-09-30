"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MossTranscribeDriver = exports.ENGINE_MOSS_TRANSCRIBE = void 0;
exports.mossTranscribeJobFields = mossTranscribeJobFields;
const parakeet_1 = require("../parakeet/parakeet");
const error_1 = require("../../lib/error");
const constants_1 = require("../../lib/constants");
const audio_1 = require("../../lib/audio");
exports.ENGINE_MOSS_TRANSCRIBE = "moss-transcribe";
const MOSS_CONFIG_KEYS = ["maxThreads", "useGPU", "backendsDir"];
const MOSS_RUN_OPTION_KEYS = ["hotwords", "prompt", "maxNewTokens"];
const MAX_HOTWORDS = 64;
const MAX_HOTWORD_BYTES = 64;
const ONE_BYTE_LIMIT = 0x80;
const TWO_BYTE_LIMIT = 0x800;
const THREE_BYTE_LIMIT = 0x10000;
const MAX_PROMPT_CHARS = 8192;
function asError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
function invalidRunOption(adds) {
    return new error_1.QvacErrorAddonASRGgml({ code: error_1.ERR_CODES_PARAKEET.INVALID_CONFIG, adds });
}
function utf8Bytes(codePoint) {
    if (codePoint < ONE_BYTE_LIMIT)
        return 1;
    if (codePoint < TWO_BYTE_LIMIT)
        return 2;
    return codePoint < THREE_BYTE_LIMIT ? 3 : 4;
}
function utf8Length(text) {
    let bytes = 0;
    for (const character of text) {
        bytes += utf8Bytes(character.codePointAt(0) ?? 0);
    }
    return bytes;
}
function isHotword(value) {
    return typeof value === "string" && value.length > 0 && utf8Length(value) <= MAX_HOTWORD_BYTES;
}
function assertHotwords(hotwords) {
    if (hotwords === undefined)
        return;
    if (!Array.isArray(hotwords) || hotwords.length > MAX_HOTWORDS || !hotwords.every(isHotword)) {
        throw invalidRunOption(`hotwords must be an array of up to ${MAX_HOTWORDS} non-empty strings of at most ` +
            `${MAX_HOTWORD_BYTES} UTF-8 bytes`);
    }
}
function assertPrompt(prompt, hotwords) {
    if (prompt === undefined)
        return;
    if (typeof prompt !== "string" || prompt.length > MAX_PROMPT_CHARS) {
        throw invalidRunOption(`prompt must be a string of at most ${MAX_PROMPT_CHARS} characters`);
    }
    if (hotwords !== undefined) {
        throw invalidRunOption("prompt replaces the default instruction and cannot be combined with hotwords");
    }
}
function assertMaxNewTokens(value) {
    if (value === undefined)
        return;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw invalidRunOption("maxNewTokens must be a non-negative integer");
    }
}
function assertKnownRunOptions(options) {
    for (const key of Object.keys(options)) {
        if (!MOSS_RUN_OPTION_KEYS.includes(key)) {
            throw invalidRunOption(`${key} is not a valid moss-transcribe run option`);
        }
    }
}
/** Validates the per-call options and returns the fields the native job reads. */
function mossTranscribeJobFields(options = {}) {
    const fields = options;
    assertKnownRunOptions(fields);
    assertHotwords(fields.hotwords);
    assertPrompt(fields.prompt, fields.hotwords);
    assertMaxNewTokens(fields.maxNewTokens);
    const present = MOSS_RUN_OPTION_KEYS.filter((key) => fields[key] !== undefined);
    return Object.fromEntries(present.map((key) => [key, fields[key]]));
}
/**
 * Returns an ArrayBuffer covering exactly the chunk's samples. Guards
 * against Float32Array views whose backing buffer is larger than the view.
 */
function chunkBuffer(chunk) {
    if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) {
        return chunk.buffer;
    }
    return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
}
/**
 * MOSS-Transcribe-Diarize engine driver: one pass over a whole recording
 * that returns timestamped, speaker-labelled segments. Backed by the
 * speech-cpp parakeet engine's MOSS transcriber through the shared native
 * binding; there is no streaming and no native reload.
 */
class MossTranscribeDriver {
    engineType = exports.ENGINE_MOSS_TRANSCRIBE;
    supportsReload = false;
    addon;
    params;
    ctx;
    _files;
    constructor(ctx, files, config) {
        this.ctx = ctx;
        this._files = { model: files.model };
        this.params = config.mossTranscribeConfig || {};
    }
    validateConfig() {
        for (const key of Object.keys(this.params)) {
            if (!MOSS_CONFIG_KEYS.includes(key)) {
                throw new error_1.QvacErrorAddonASRGgml({
                    code: error_1.ERR_CODES_PARAKEET.INVALID_CONFIG,
                    adds: `${key} is not a valid parameter for mossTranscribeConfig`,
                });
            }
        }
    }
    normalizeAudio(input) {
        return (0, audio_1.normalizeAudioStream)(input, "s16le");
    }
    async load() {
        const configurationParams = this._buildConfigurationParams();
        this.ctx.logger.info("Creating MOSS-Transcribe addon with configuration:", configurationParams);
        this.addon = this._createAddon(configurationParams);
        await this.addon.activate();
    }
    async unload() {
        if (this.addon)
            await this.addon.destroyInstance();
    }
    reload() {
        return Promise.reject(new error_1.QvacErrorAddonASRGgml({ code: error_1.ERR_CODES.NOT_SUPPORTED, adds: "reload (moss-transcribe)" }));
    }
    async cancelActive(jobId) {
        if (this.addon?.cancel)
            await this.addon.cancel(jobId);
        if (this.ctx.job.active) {
            this.ctx.job.fail(new error_1.QvacErrorAddonASRGgml(error_1.ERR_CODES_PARAKEET.JOB_CANCELLED));
        }
    }
    async status() {
        if (!this.addon?.status) {
            throw new error_1.QvacErrorAddonASRGgml({
                code: error_1.ERR_CODES_PARAKEET.FAILED_TO_GET_STATUS,
                adds: "addon is not loaded",
            });
        }
        return await this.addon.status();
    }
    getBackendInfo() {
        return this.addon?.getBackendInfo?.() ?? null;
    }
    run(audio, options = {}) {
        const job = mossTranscribeJobFields(options);
        const response = this.ctx.job.start();
        void this._pumpBatchAudio(audio, job).catch((error) => {
            this.ctx.job.fail(asError(error));
        });
        return Promise.resolve(response);
    }
    createStreamingSession() {
        return Promise.reject(new error_1.QvacErrorAddonASRGgml({
            code: error_1.ERR_CODES.NOT_SUPPORTED,
            adds: "runStreaming (moss-transcribe transcribes whole recordings; use run())",
        }));
    }
    async _pumpBatchAudio(audio, job) {
        const addon = this._requireAddon();
        for await (const chunk of audio) {
            if (!this.ctx.job.active)
                return;
            await addon.append({ type: "audio", data: chunkBuffer(chunk) });
        }
        if (!this.ctx.job.active)
            return;
        await addon.append({ type: constants_1.END_OF_INPUT, job });
    }
    _buildConfigurationParams() {
        return {
            engineType: exports.ENGINE_MOSS_TRANSCRIBE,
            modelPath: this._files.model || "",
            maxThreads: this.params.maxThreads ?? 0,
            useGPU: this.params.useGPU === true,
            backendsDir: this.params.backendsDir,
        };
    }
    _createAddon(configurationParams) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
        const binding = require("../../binding.js");
        return new parakeet_1.ParakeetInterface(binding, configurationParams, this._outputCallback.bind(this), this.ctx.logger.info.bind(this.ctx.logger));
    }
    _outputCallback(_addon, event, _jobId, data, error) {
        if (event === "Error") {
            this.ctx.job.fail(asError(error));
            return;
        }
        if (event === "Output") {
            this.ctx.job.output(data);
            return;
        }
        if (event === "JobEnded") {
            if (this.ctx.enableStats)
                this.ctx.job.end(data);
            else
                this.ctx.job.end();
        }
    }
    _requireAddon() {
        if (!this.addon) {
            throw new Error("MOSS-Transcribe addon is not loaded");
        }
        return this.addon;
    }
}
exports.MossTranscribeDriver = MossTranscribeDriver;
