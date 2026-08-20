"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MINIMAX_CHANNELS = exports.MINIMAX_SAMPLE_RATE = exports.MAX_EVENT_BYTES = exports.MAX_REQUEST_BYTES = exports.PROTOCOL_VERSION = void 0;
exports.parseWorkerRequest = parseWorkerRequest;
exports.encodeWorkerRequest = encodeWorkerRequest;
exports.parseWorkerEvent = parseWorkerEvent;
exports.PROTOCOL_VERSION = 1;
exports.MAX_REQUEST_BYTES = 64 * 1024;
exports.MAX_EVENT_BYTES = 16 * 1024 * 1024;
exports.MINIMAX_SAMPLE_RATE = 44_100;
exports.MINIMAX_CHANNELS = 2;
function utf8ByteLength(value) {
    return new TextEncoder().encode(value).byteLength;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requireString(record, key) {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${key} must be a non-empty string`);
    }
    return value;
}
function requirePositiveInteger(record, key) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${key} must be a positive safe integer`);
    }
    return value;
}
function optionalFiniteNumber(record, key) {
    const value = record[key];
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${key} must be a finite number`);
    }
    return value;
}
function validateConfig(value) {
    if (!isRecord(value))
        throw new TypeError('config must be an object');
    const modelDir = requireString(value, 'modelDir');
    const cacheDir = value['cacheDir'] === undefined ? undefined : requireString(value, 'cacheDir');
    if (value['device'] !== undefined && value['device'] !== 'cuda') {
        throw new TypeError('device must be cuda');
    }
    if (value['torchDtype'] !== undefined && value['torchDtype'] !== 'bfloat16') {
        throw new TypeError('torchDtype must be bfloat16');
    }
    return { modelDir, cacheDir, device: 'cuda', torchDtype: 'bfloat16' };
}
function parseWorkerRequest(value) {
    if (!isRecord(value))
        throw new TypeError('request must be an object');
    if (value['version'] !== exports.PROTOCOL_VERSION) {
        throw new TypeError(`unsupported protocol version: ${String(value['version'])}`);
    }
    switch (value['op']) {
        case 'load':
            return { version: exports.PROTOCOL_VERSION, op: 'load', config: validateConfig(value['config']) };
        case 'generate':
            return {
                version: exports.PROTOCOL_VERSION,
                op: 'generate',
                requestId: requireString(value, 'requestId'),
                caption: requireString(value, 'caption'),
                lyrics: requireString(value, 'lyrics'),
                maxFrames: requirePositiveInteger(value, 'maxFrames'),
                seed: optionalFiniteNumber(value, 'seed'),
                inferenceSteps: optionalFiniteNumber(value, 'inferenceSteps'),
                cfgScale: optionalFiniteNumber(value, 'cfgScale')
            };
        case 'cancel':
            return { version: exports.PROTOCOL_VERSION, op: 'cancel', requestId: requireString(value, 'requestId') };
        case 'unload':
            return { version: exports.PROTOCOL_VERSION, op: 'unload' };
        default:
            throw new TypeError(`unsupported operation: ${String(value['op'])}`);
    }
}
function encodeWorkerRequest(request) {
    const line = `${JSON.stringify(parseWorkerRequest(request))}\n`;
    if (utf8ByteLength(line) > exports.MAX_REQUEST_BYTES) {
        throw new RangeError('worker request exceeds 64 KiB');
    }
    return line;
}
function parseWorkerEvent(value) {
    if (!isRecord(value))
        throw new TypeError('worker event must be an object');
    if (value['version'] !== exports.PROTOCOL_VERSION) {
        throw new TypeError(`unsupported protocol version: ${String(value['version'])}`);
    }
    if (typeof value['status'] !== 'string')
        throw new TypeError('worker event status must be a string');
    return value;
}
