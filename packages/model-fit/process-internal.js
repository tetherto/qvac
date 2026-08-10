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
function boundedInvocationError(error, exitCode) {
    const response = invocationError(error);
    try {
        return { response, responseLine: encodeFitProcessResponse(response), exitCode };
    }
    catch {
        const bounded = invocationError(new RangeError('Fit process response exceeds 1 MiB'));
        return { response: bounded, responseLine: encodeFitProcessResponse(bounded), exitCode };
    }
}
function runFitProcessLine(line, fit) {
    // The sender spends a byte of its budget on the newline delimiter, so charge
    // the request for it here too rather than bounding a different quantity.
    if (Buffer.byteLength(line, 'utf8') + 1 > process_1.FIT_PROCESS_MAX_REQUEST_BYTES) {
        return boundedInvocationError(new RangeError('Fit process request exceeds 64 KiB'), 2);
    }
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch (error) {
        return boundedInvocationError(error, 2);
    }
    let request;
    try {
        request = parseFitProcessRequest(parsed);
    }
    catch (error) {
        return boundedInvocationError(error, 2);
    }
    try {
        const response = {
            version: process_1.FIT_PROCESS_PROTOCOL_VERSION,
            status: 'completed',
            result: fit(request.config)
        };
        return { response, responseLine: encodeFitProcessResponse(response), exitCode: 0 };
    }
    catch (error) {
        return boundedInvocationError(error, 1);
    }
}
