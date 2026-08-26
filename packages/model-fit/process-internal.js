"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseFitProcessRequest = parseFitProcessRequest;
exports.encodeFitProcessResponse = encodeFitProcessResponse;
exports.runFitProcessLine = runFitProcessLine;
const process_1 = require("./process");
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseFitLlamaProcessConfig(value) {
    const allowedFields = new Set(['modelPath', 'params', 'backendsDir', 'marginMiB', 'nCtxMin']);
    for (const key of Object.keys(value)) {
        if (!allowedFields.has(key)) {
            throw new TypeError(`Fit process request config unknown top-level field '${key}'`);
        }
    }
    if (typeof value['modelPath'] !== 'string' || value['modelPath'].length === 0) {
        throw new TypeError('Fit process request config modelPath must be a non-empty string');
    }
    if (Buffer.byteLength(value['modelPath'], 'utf8') > 4096) {
        throw new RangeError('Fit process request config modelPath must not exceed 4096 bytes');
    }
    if (!isRecord(value['params'])) {
        throw new TypeError('Fit process request llama params must be an object');
    }
    const entries = Object.entries(value['params']);
    if (entries.length > 256) {
        throw new RangeError('Fit process request llama config must not contain more than 256 entries');
    }
    for (const [key, entry] of entries) {
        if (typeof entry !== 'string') {
            throw new TypeError(`Fit process request llama params.${key} must be a string`);
        }
        if (Buffer.byteLength(key, 'utf8') === 0 || Buffer.byteLength(key, 'utf8') > 128) {
            throw new RangeError('Fit process request llama config keys must be 1 to 128 bytes');
        }
        if (Buffer.byteLength(entry, 'utf8') > 4096) {
            throw new RangeError('Fit process request llama config values must not exceed 4096 bytes');
        }
    }
    for (const key of ['marginMiB', 'nCtxMin']) {
        const option = value[key];
        if (option !== undefined &&
            (typeof option !== 'number' ||
                !Number.isSafeInteger(option) ||
                option < 0 ||
                option > 4294967295)) {
            throw new RangeError(`Fit process request config ${key} must be a uint32`);
        }
    }
    if (value['backendsDir'] !== undefined &&
        (typeof value['backendsDir'] !== 'string' ||
            value['backendsDir'].length === 0 ||
            Buffer.byteLength(value['backendsDir'], 'utf8') > 4096)) {
        throw new TypeError('Fit process request config backendsDir must be a non-empty string no longer than 4096 bytes');
    }
    return value;
}
function parseFitProcessRequest(value) {
    if (!isRecord(value)) {
        throw new TypeError('Fit process request must be an object');
    }
    if (value['version'] !== process_1.FIT_PROCESS_PROTOCOL_VERSION &&
        value['version'] !== process_1.FIT_PROCESS_PROTOCOL_VERSION_V2) {
        throw new TypeError(`Unsupported fit process protocol version: ${String(value['version'])}`);
    }
    if (value['version'] === process_1.FIT_PROCESS_PROTOCOL_VERSION_V2) {
        for (const key of Object.keys(value)) {
            if (key !== 'version' && key !== 'loadKind' && key !== 'config') {
                throw new TypeError(`Fit process request unknown v2 envelope field '${key}'`);
            }
        }
        if (value['loadKind'] !== 'completion' && value['loadKind'] !== 'embedding') {
            throw new TypeError("Fit process request loadKind must be 'completion' or 'embedding'");
        }
    }
    if (!isRecord(value['config'])) {
        throw new TypeError('Fit process request config must be an object');
    }
    if (value['version'] === process_1.FIT_PROCESS_PROTOCOL_VERSION_V2) {
        const loadKind = value['loadKind'];
        if (loadKind !== 'completion' && loadKind !== 'embedding') {
            throw new TypeError("Fit process request loadKind must be 'completion' or 'embedding'");
        }
        return {
            version: process_1.FIT_PROCESS_PROTOCOL_VERSION_V2,
            loadKind,
            config: parseFitLlamaProcessConfig(value['config'])
        };
    }
    if (typeof value['config']['modelPath'] !== 'string') {
        throw new TypeError('Fit process request config modelPath must be a string');
    }
    return {
        version: process_1.FIT_PROCESS_PROTOCOL_VERSION,
        config: value['config']
    };
}
function encodeFitProcessResponse(response) {
    const encoded = `${JSON.stringify(response)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > process_1.FIT_PROCESS_MAX_RESPONSE_BYTES) {
        throw new RangeError('Fit process response exceeds 1 MiB');
    }
    return encoded;
}
function invocationError(error, version) {
    return {
        version,
        status: 'invocation-error',
        error: {
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error)
        }
    };
}
function boundedInvocationError(error, exitCode, version) {
    const response = invocationError(error, version);
    try {
        return { response, responseLine: encodeFitProcessResponse(response), exitCode };
    }
    catch {
        const bounded = invocationError(new RangeError('Fit process response exceeds 1 MiB'), version);
        return { response: bounded, responseLine: encodeFitProcessResponse(bounded), exitCode };
    }
}
function recognizableRequestVersion(value) {
    return isRecord(value) && value['version'] === process_1.FIT_PROCESS_PROTOCOL_VERSION_V2
        ? process_1.FIT_PROCESS_PROTOCOL_VERSION_V2
        : process_1.FIT_PROCESS_PROTOCOL_VERSION;
}
function runFitProcessLine(line, fit, fitLlama = () => {
    throw new TypeError('Fit process v2 is not available');
}) {
    if (Buffer.byteLength(line, 'utf8') + 1 > process_1.FIT_PROCESS_MAX_REQUEST_BYTES) {
        return boundedInvocationError(new RangeError('Fit process request exceeds 64 KiB'), 2, process_1.FIT_PROCESS_PROTOCOL_VERSION);
    }
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch (error) {
        return boundedInvocationError(error, 2, process_1.FIT_PROCESS_PROTOCOL_VERSION);
    }
    let request;
    try {
        request = parseFitProcessRequest(parsed);
    }
    catch (error) {
        return boundedInvocationError(error, 2, recognizableRequestVersion(parsed));
    }
    try {
        // Built per branch rather than from a shared `result`: the version and the
        // result type are correlated — only v2 can answer `unsupported-config` —
        // and assembling the envelope once would decorrelate them.
        const response = request.version === process_1.FIT_PROCESS_PROTOCOL_VERSION
            ? { version: request.version, status: 'completed', result: fit(request.config) }
            : {
                version: request.version,
                status: 'completed',
                result: fitLlama(request.loadKind, request.config)
            };
        return { response, responseLine: encodeFitProcessResponse(response), exitCode: 0 };
    }
    catch (error) {
        return boundedInvocationError(error, 1, request.version);
    }
}
