"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LlmSglang = void 0;
exports.validateMessages = validateMessages;
const infer_base_1 = require("@qvac/infer-base");
const addon_1 = require("./addon");
const SERVER_NOT_STARTED = 'SGLang server is not started. Call load() first.';
// @qvac/sglang is ESM. A static import() is rewritten to require() under
// CommonJS, which throws ERR_REQUIRE_ESM, so keep the import unevaluated.
function importSglang() {
    return new Function('return import("@qvac/sglang")')();
}
const serverOptionKeys = [
    'maxConnections',
    'tpSize',
    'epSize',
    'dpSize',
    'ppSize',
    'cpSize',
    'contextLength',
    'maxTotalTokens',
    'maxRunningRequests',
    'maxPrefillTokens',
    'memFractionStatic',
    'cudaGraphBatchSizes',
    'cachePolicy',
    'maxHttpRequests',
    'maxRequestBytes',
    'apiKey',
    'corsAllowOrigin',
    'queueTimeout',
    'requestTimeout',
    'streamIdleTimeout',
    'cudaGraph',
    'extraArgs',
    'artifacts'
];
function lower(value) {
    return value.toLowerCase();
}
function extensionOf(path) {
    const dot = path.lastIndexOf('.');
    return dot === -1 ? '' : lower(path.slice(dot + 1));
}
function mediaKind(message) {
    const hint = lower(`${message.type} ${message.mediaType ?? ''} ${message.mime ?? ''}`);
    if (hint.includes('audio'))
        return 'audio';
    if (hint.includes('video'))
        return 'video';
    const path = typeof message.content === 'string' ? message.content : '';
    const ext = extensionOf(path);
    if (ext === 'wav' || ext === 'mp3' || ext === 'flac' || ext === 'ogg' || ext === 'm4a') {
        return 'audio';
    }
    if (ext === 'mp4' || ext === 'webm' || ext === 'mov' || ext === 'mkv') {
        return 'video';
    }
    return 'image';
}
function isMediaMessage(message) {
    return (message.type === 'media' ||
        message.type === 'image' ||
        message.type === 'audio' ||
        message.type === 'video');
}
function validateMessages(messages) {
    if (!Array.isArray(messages)) {
        throw new TypeError('Prompt input must be Message[]');
    }
    if (messages.length === 0) {
        throw new TypeError('messages must not be empty');
    }
    for (const message of messages) {
        if (!message || typeof message !== 'object') {
            throw new TypeError('each message must be an object');
        }
        const candidate = message;
        if (typeof candidate.role !== 'string' || candidate.role.length === 0) {
            throw new TypeError('each message requires a role');
        }
        if (typeof candidate.content !== 'string' && !(candidate.content instanceof Uint8Array)) {
            throw new TypeError('message content must be a string or Uint8Array');
        }
        if (isMediaMessage(candidate)) {
            const kind = mediaKind(candidate);
            if (kind === 'audio') {
                throw new TypeError('audio inputs are not supported');
            }
            if (kind === 'video') {
                throw new TypeError('video inputs are not supported');
            }
        }
    }
}
function normalizeGenerationParams(params) {
    if (params === undefined)
        return undefined;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
        throw new TypeError('generationParams must be an object when provided');
    }
    const normalized = { ...params };
    if (normalized.temp !== undefined && normalized.temperature === undefined) {
        normalized.temperature = normalized.temp;
    }
    delete normalized.temp;
    if (normalized.predict !== undefined && normalized.max_tokens === undefined) {
        normalized.max_tokens = normalized.predict;
    }
    delete normalized.predict;
    if (normalized.repeat_penalty !== undefined && normalized.repetition_penalty === undefined) {
        normalized.repetition_penalty = normalized.repeat_penalty;
    }
    delete normalized.repeat_penalty;
    if (normalized.json_schema && typeof normalized.json_schema === 'object') {
        normalized.json_schema = JSON.stringify(normalized.json_schema);
    }
    return normalized;
}
function trimSlash(url) {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
async function waitUntilReady(baseUrl, server, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let exited;
    server.on('exit', (code) => {
        exited = code;
    });
    while (Date.now() < deadline) {
        if (exited !== undefined) {
            throw new Error(`SGLang server exited before it was ready (code ${exited ?? 'null'})`);
        }
        try {
            const response = await fetch(`${baseUrl}/ready`);
            if (response.ok)
                return;
        }
        catch {
            // The process is still binding its port.
        }
        await sleep(500);
    }
    throw new Error(`SGLang server was not ready within ${timeoutMs}ms`);
}
class LlmSglang {
    logger;
    files;
    config;
    addon;
    server;
    job;
    runExclusive;
    loaded;
    constructor({ files = {}, config = {}, logger = null } = {}) {
        this.files = files;
        this.config = config;
        this.logger = logger;
        this.addon = null;
        this.server = null;
        this.loaded = false;
        this.job = (0, infer_base_1.createJobHandler)({
            cancel: () => this.addon?.cancel()
        });
        this.runExclusive = (0, infer_base_1.exclusiveRunQueue)();
    }
    async load() {
        return this.runExclusive(async () => {
            if (this.loaded)
                return;
            const baseUrl = await this.ensureServer();
            try {
                // The native module is resolved only after the server URL is known.
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const binding = require('./binding');
                this.addon = new addon_1.LlmSglangInterface(binding, { baseUrl }, this.onOutput.bind(this));
                await this.addon.activate();
                this.loaded = true;
                this.logger?.info?.('SGLang addon loaded');
            }
            catch (error) {
                await this.addon?.unload();
                this.addon = null;
                this.stopServer();
                throw error;
            }
        });
    }
    run(messages, runOptions) {
        validateMessages(messages);
        if (runOptions !== undefined &&
            (typeof runOptions !== 'object' || runOptions === null || Array.isArray(runOptions))) {
            throw new TypeError('Run options must be an object when provided');
        }
        const generationParams = normalizeGenerationParams(runOptions?.generationParams);
        if (!this.loaded || !this.addon) {
            throw new Error(SERVER_NOT_STARTED);
        }
        const response = this.job.start();
        const addon = this.addon;
        void Promise.resolve(addon.runJob({ messages, generationParams })).then((accepted) => {
            if (!accepted) {
                this.job.fail(new Error('SGLang job was rejected'));
            }
        }, (error) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            this.job.fail(failure);
        });
        return response;
    }
    async cancel() {
        await this.addon?.cancel();
    }
    async unload() {
        return this.runExclusive(async () => {
            try {
                await this.addon?.cancel();
            }
            catch {
                // Unload still destroys the instance.
            }
            if (this.job.active) {
                this.job.fail(new Error('Model was unloaded'));
            }
            if (this.addon) {
                await this.addon.unload();
                this.addon = null;
            }
            this.stopServer();
            this.loaded = false;
        });
    }
    async ensureServer() {
        if (this.config.baseUrl) {
            return trimSlash(this.config.baseUrl);
        }
        const model = this.files.model?.[0];
        if (!model) {
            throw new Error('load() requires files.model or config.baseUrl');
        }
        const host = this.config.host ?? '127.0.0.1';
        const port = this.config.port ?? 30000;
        const options = { model, host, port, stdio: 'inherit' };
        for (const key of serverOptionKeys) {
            const value = this.config[key];
            if (value !== undefined)
                options[key] = value;
        }
        const sglang = await importSglang();
        this.server = sglang.startServer(options);
        const baseUrl = `http://${host}:${port}`;
        try {
            await waitUntilReady(baseUrl, this.server, this.config.readyTimeoutMs ?? 600_000);
        }
        catch (error) {
            this.stopServer();
            throw error;
        }
        return baseUrl;
    }
    stopServer() {
        const server = this.server;
        this.server = null;
        if (server && server.exitCode === null) {
            server.kill('SIGTERM');
        }
    }
    onOutput(_addon, event, data, error) {
        const mapped = (0, addon_1.mapAddonEvent)(event, data, error);
        if (mapped === null)
            return;
        if (mapped.type === 'Output') {
            if (typeof mapped.data === 'string' && mapped.data.length > 0) {
                this.job.output(mapped.data);
            }
            return;
        }
        if (mapped.type === 'Error') {
            const failure = mapped.error instanceof Error
                ? mapped.error
                : new Error(typeof mapped.error === 'string' ? mapped.error : 'SGLang request failed');
            this.job.fail(failure);
            return;
        }
        this.job.end();
    }
}
exports.LlmSglang = LlmSglang;
exports.default = LlmSglang;
const cjsExports = LlmSglang;
cjsExports.LlmSglang = LlmSglang;
cjsExports.validateMessages = validateMessages;
module.exports = cjsExports;
