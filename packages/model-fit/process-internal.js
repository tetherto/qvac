"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseFitProcessRequest = parseFitProcessRequest;
exports.encodeFitProcessResponse = encodeFitProcessResponse;
exports.runFitProcessLine = runFitProcessLine;
const process_1 = require("./process");
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseFitProcessRequest(value) {
    if (!isRecord(value)) {
        throw new TypeError('Fit process request must be an object');
    }
    if (value['version'] !== process_1.FIT_PROCESS_PROTOCOL_VERSION) {
        throw new TypeError(`Unsupported fit process protocol version: ${String(value['version'])}`);
    }
    const config = value['config'];
    if (!isRecord(config)) {
        throw new TypeError('Fit process request config must be an object');
    }
    if (typeof config['modelPath'] !== 'string') {
        throw new TypeError('Fit process request config modelPath must be a string');
    }
    return {
        version: process_1.FIT_PROCESS_PROTOCOL_VERSION,
        config: config
    };
}
function encodeFitProcessResponse(response) {
    const encoded = `${JSON.stringify(response)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > process_1.FIT_PROCESS_MAX_RESPONSE_BYTES) {
        throw new RangeError('Fit process response exceeds 1 MiB');
    }
    return encoded;
}
function invocationError(error) {
    return {
        version: process_1.FIT_PROCESS_PROTOCOL_VERSION,
        status: 'invocation-error',
        error: {
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error)
        }
    };
}
function boundedInvocationError(error) {
    const response = invocationError(error);
    try {
        encodeFitProcessResponse(response);
        return response;
    }
    catch {
        return invocationError(new RangeError('Fit process response exceeds 1 MiB'));
    }
}
function runFitProcessLine(line, fit) {
    if (Buffer.byteLength(line, 'utf8') > process_1.FIT_PROCESS_MAX_REQUEST_BYTES) {
        return {
            response: boundedInvocationError(new RangeError('Fit process request exceeds 64 KiB')),
            exitCode: 2
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch (error) {
        return { response: boundedInvocationError(error), exitCode: 2 };
    }
    let request;
    try {
        request = parseFitProcessRequest(parsed);
    }
    catch (error) {
        return { response: boundedInvocationError(error), exitCode: 2 };
    }
    try {
        const response = {
            version: process_1.FIT_PROCESS_PROTOCOL_VERSION,
            status: 'completed',
            result: fit(request.config)
        };
        encodeFitProcessResponse(response);
        return { response, exitCode: 0 };
    }
    catch (error) {
        return { response: boundedInvocationError(error), exitCode: 1 };
    }
}
