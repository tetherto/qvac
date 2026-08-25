"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FIT_PROCESS_MAX_RESPONSE_BYTES = exports.FIT_PROCESS_MAX_REQUEST_BYTES = exports.FIT_PROCESS_PROTOCOL_VERSION_V2 = exports.FIT_PROCESS_PROTOCOL_VERSION = void 0;
exports.encodeFitProcessRequest = encodeFitProcessRequest;
exports.encodeFitLlamaProcessRequest = encodeFitLlamaProcessRequest;
exports.parseFitProcessResponse = parseFitProcessResponse;
exports.resolveFitProcessRunnerPath = resolveFitProcessRunnerPath;
exports.FIT_PROCESS_PROTOCOL_VERSION = 1;
exports.FIT_PROCESS_PROTOCOL_VERSION_V2 = 2;
exports.FIT_PROCESS_MAX_REQUEST_BYTES = 64 * 1024;
exports.FIT_PROCESS_MAX_RESPONSE_BYTES = 1024 * 1024;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function assertNumber(record, key) {
    if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) {
        throw new TypeError(`Fit process result ${key} must be a number`);
    }
}
function assertOptionalNumber(record, key) {
    if (record[key] !== undefined)
        assertNumber(record, key);
}
function assertFitPlan(result, required) {
    for (const key of [
        'nGpuLayers',
        'nCtx',
        'nBatch',
        'nUbatch',
        'splitMode',
        'mainGpu',
        'typeK',
        'typeV',
        'flashAttnType'
    ]) {
        if (required)
            assertNumber(result, key);
        else
            assertOptionalNumber(result, key);
    }
    if ((required || result['tensorSplit'] !== undefined) &&
        (!Array.isArray(result['tensorSplit']) ||
            !result['tensorSplit'].every(entry => typeof entry === 'number' && Number.isFinite(entry)))) {
        throw new TypeError('Fit process result tensorSplit must be an array of numbers');
    }
    if ((required || result['buftOverrides'] !== undefined) && !Array.isArray(result['buftOverrides'])) {
        throw new TypeError('Fit process result buftOverrides must be an array');
    }
    if (Array.isArray(result['buftOverrides'])) {
        for (const override of result['buftOverrides']) {
            if (!isRecord(override) ||
                typeof override['pattern'] !== 'string' ||
                typeof override['bufferType'] !== 'string') {
                throw new TypeError('Fit process result buftOverrides entries must contain string fields');
            }
        }
    }
}
// `unsupported-config` is reachable only through the v2 llama-load path, so the
// parser enforces that rather than accepting it on either envelope: a v1
// response carrying it is malformed, not merely unusual.
const V1_ERROR_REASONS = ['model-unreadable', 'no-backend-device'];
const V2_ERROR_REASONS = [...V1_ERROR_REASONS, 'unsupported-config'];
function assertFitResultShape(value, errorReasons) {
    if (!isRecord(value)) {
        throw new TypeError('Fit process result must be an object');
    }
    assertNumber(value, 'maxDevices');
    assertNumber(value, 'nDevices');
    assertNumber(value, 'nGpuDevices');
    switch (value['status']) {
        case 0:
            if (value['fits'] !== true || value['reason'] !== 'fits') {
                throw new TypeError("Fit process result must report fits for status 0");
            }
            assertFitPlan(value, true);
            if (value['nCtx'] <= 0) {
                throw new TypeError('Fit process result nCtx must be greater than 0 for status 0');
            }
            return;
        case 1:
            if (value['fits'] !== false || value['reason'] !== 'does-not-fit') {
                throw new TypeError("Fit process result must report does-not-fit for status 1");
            }
            assertFitPlan(value, false);
            return;
        case 2:
            if (value['fits'] !== false || !errorReasons.includes(value['reason'])) {
                throw new TypeError('Fit process result reason is invalid for status 2');
            }
            assertFitPlan(value, false);
            return;
        default:
            throw new TypeError(`Fit process result status is invalid: ${String(value['status'])}`);
    }
}
function assertFitResult(value) {
    assertFitResultShape(value, V1_ERROR_REASONS);
}
function assertFitLlamaResult(value) {
    assertFitResultShape(value, V2_ERROR_REASONS);
}
function encodeFitProcessRequestEnvelope(request) {
    const encoded = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > exports.FIT_PROCESS_MAX_REQUEST_BYTES) {
        throw new RangeError('Fit process request exceeds 64 KiB');
    }
    return encoded;
}
function assertLlamaLoadKind(loadKind) {
    if (loadKind !== 'completion' && loadKind !== 'embedding') {
        throw new TypeError("Fit process loadKind must be 'completion' or 'embedding'");
    }
}
function assertFitLlamaProcessConfig(config) {
    if (!isRecord(config) || typeof config.modelPath !== 'string' || config.modelPath.length === 0) {
        throw new TypeError('Fit process llama config modelPath must be a non-empty string');
    }
    const allowedFields = new Set(['modelPath', 'params', 'backendsDir', 'marginMiB', 'nCtxMin']);
    for (const key of Object.keys(config)) {
        if (!allowedFields.has(key)) {
            throw new TypeError(`Fit process llama config unknown top-level field '${key}'`);
        }
    }
    if (Buffer.byteLength(config.modelPath, 'utf8') > 4096) {
        throw new RangeError('Fit process llama config modelPath must not exceed 4096 bytes');
    }
    if (config.backendsDir !== undefined &&
        (typeof config.backendsDir !== 'string' ||
            config.backendsDir.length === 0 ||
            Buffer.byteLength(config.backendsDir, 'utf8') > 4096)) {
        throw new RangeError('Fit process llama config backendsDir must be a non-empty string no longer than 4096 bytes');
    }
    if (!isRecord(config.params)) {
        throw new TypeError('Fit process llama config params must be an object');
    }
    const entries = Object.entries(config.params);
    if (entries.length > 256) {
        throw new RangeError('Fit process llama config must not contain more than 256 entries');
    }
    for (const [key, value] of entries) {
        if (typeof value !== 'string') {
            throw new TypeError(`Fit process llama config params.${key} must be a string`);
        }
        if (Buffer.byteLength(key, 'utf8') === 0 || Buffer.byteLength(key, 'utf8') > 128) {
            throw new RangeError('Fit process llama config keys must be 1 to 128 bytes');
        }
        if (Buffer.byteLength(value, 'utf8') > 4096) {
            throw new RangeError('Fit process llama config values must not exceed 4096 bytes');
        }
    }
    for (const key of ['marginMiB', 'nCtxMin']) {
        const value = config[key];
        if (value !== undefined &&
            (!Number.isSafeInteger(value) || value < 0 || value > 4294967295)) {
            throw new RangeError(`Fit process llama config ${key} must be a uint32`);
        }
    }
}
function encodeFitProcessRequest(config) {
    return encodeFitProcessRequestEnvelope({
        version: exports.FIT_PROCESS_PROTOCOL_VERSION,
        config
    });
}
function encodeFitLlamaProcessRequest(loadKind, config) {
    assertLlamaLoadKind(loadKind);
    assertFitLlamaProcessConfig(config);
    return encodeFitProcessRequestEnvelope({
        version: exports.FIT_PROCESS_PROTOCOL_VERSION_V2,
        loadKind,
        config
    });
}
function parseFitProcessResponse(value) {
    if (!isRecord(value)) {
        throw new TypeError('Fit process response must be an object');
    }
    if (value['version'] !== exports.FIT_PROCESS_PROTOCOL_VERSION &&
        value['version'] !== exports.FIT_PROCESS_PROTOCOL_VERSION_V2) {
        throw new TypeError(`Unsupported fit process protocol version: ${String(value['version'])}`);
    }
    const version = value['version'];
    switch (value['status']) {
        case 'completed':
            if (version === exports.FIT_PROCESS_PROTOCOL_VERSION_V2) {
                assertFitLlamaResult(value['result']);
                return { version, status: 'completed', result: value['result'] };
            }
            assertFitResult(value['result']);
            return { version, status: 'completed', result: value['result'] };
        case 'invocation-error': {
            const error = value['error'];
            if (!isRecord(error)) {
                throw new TypeError('Fit process response error must be an object');
            }
            if (typeof error['name'] !== 'string' || typeof error['message'] !== 'string') {
                throw new TypeError('Fit process response error fields must be strings');
            }
            return {
                version,
                status: 'invocation-error',
                error: { name: error['name'], message: error['message'] }
            };
        }
        default:
            throw new TypeError(`Fit process response status is invalid: ${String(value['status'])}`);
    }
}
function resolveFitProcessRunnerPath() {
    return require.resolve('./process-runner.js');
}
