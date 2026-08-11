"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FIT_PROCESS_MAX_RESPONSE_BYTES = exports.FIT_PROCESS_MAX_REQUEST_BYTES = exports.FIT_PROCESS_PROTOCOL_VERSION = void 0;
exports.encodeFitProcessRequest = encodeFitProcessRequest;
exports.parseFitProcessResponse = parseFitProcessResponse;
exports.resolveFitProcessRunnerPath = resolveFitProcessRunnerPath;
exports.FIT_PROCESS_PROTOCOL_VERSION = 1;
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
function assertTensorSplit(value, required) {
    if (!required && value === undefined)
        return;
    if (!Array.isArray(value) || !value.every(entry => typeof entry === 'number' && Number.isFinite(entry))) {
        throw new TypeError('Fit process result tensorSplit must be an array of numbers');
    }
}
function assertBuftOverrides(value, required) {
    if (!required && value === undefined)
        return;
    if (!Array.isArray(value)) {
        throw new TypeError('Fit process result buftOverrides must be an array');
    }
    for (const override of value) {
        if (!isRecord(override)) {
            throw new TypeError('Fit process result buftOverrides entries must be objects');
        }
        if (typeof override['pattern'] !== 'string') {
            throw new TypeError('Fit process result buftOverrides pattern must be a string');
        }
        if (typeof override['bufferType'] !== 'string') {
            throw new TypeError('Fit process result buftOverrides bufferType must be a string');
        }
    }
}
function assertFitPlan(result, required) {
    const numericFields = [
        'nGpuLayers',
        'nCtx',
        'nBatch',
        'nUbatch',
        'splitMode',
        'mainGpu',
        'typeK',
        'typeV',
        'flashAttnType'
    ];
    for (const key of numericFields) {
        if (required)
            assertNumber(result, key);
        else
            assertOptionalNumber(result, key);
    }
    assertTensorSplit(result['tensorSplit'], required);
    assertBuftOverrides(result['buftOverrides'], required);
}
function assertFitResult(value) {
    if (!isRecord(value)) {
        throw new TypeError('Fit process result must be an object');
    }
    assertNumber(value, 'maxDevices');
    assertNumber(value, 'nDevices');
    assertNumber(value, 'nGpuDevices');
    switch (value['status']) {
        case 0:
            if (value['fits'] !== true) {
                throw new TypeError('Fit process result fits must be true for status 0');
            }
            if (value['reason'] !== 'fits') {
                throw new TypeError("Fit process result reason must be 'fits' for status 0");
            }
            assertFitPlan(value, true);
            return;
        case 1:
            if (value['fits'] !== false) {
                throw new TypeError('Fit process result fits must be false for status 1');
            }
            if (value['reason'] !== 'does-not-fit') {
                throw new TypeError("Fit process result reason must be 'does-not-fit' for status 1");
            }
            assertFitPlan(value, false);
            return;
        case 2:
            if (value['fits'] !== false) {
                throw new TypeError('Fit process result fits must be false for status 2');
            }
            if (value['reason'] !== 'model-unreadable' && value['reason'] !== 'no-backend-device') {
                throw new TypeError('Fit process result reason is invalid for status 2');
            }
            assertFitPlan(value, false);
            return;
        default:
            throw new TypeError(`Fit process result status is invalid: ${String(value['status'])}`);
    }
}
function encodeFitProcessRequest(config) {
    const request = {
        version: exports.FIT_PROCESS_PROTOCOL_VERSION,
        config
    };
    const encoded = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > exports.FIT_PROCESS_MAX_REQUEST_BYTES) {
        throw new RangeError('Fit process request exceeds 64 KiB');
    }
    return encoded;
}
function parseFitProcessResponse(value) {
    if (!isRecord(value)) {
        throw new TypeError('Fit process response must be an object');
    }
    if (value['version'] !== exports.FIT_PROCESS_PROTOCOL_VERSION) {
        throw new TypeError(`Unsupported fit process protocol version: ${String(value['version'])}`);
    }
    switch (value['status']) {
        case 'completed':
            assertFitResult(value['result']);
            return {
                version: exports.FIT_PROCESS_PROTOCOL_VERSION,
                status: 'completed',
                result: value['result']
            };
        case 'invocation-error': {
            const error = value['error'];
            if (!isRecord(error)) {
                throw new TypeError('Fit process response error must be an object');
            }
            if (typeof error['name'] !== 'string') {
                throw new TypeError('Fit process response error name must be a string');
            }
            if (typeof error['message'] !== 'string') {
                throw new TypeError('Fit process response error message must be a string');
            }
            return {
                version: exports.FIT_PROCESS_PROTOCOL_VERSION,
                status: 'invocation-error',
                error: {
                    name: error['name'],
                    message: error['message']
                }
            };
        }
        default:
            throw new TypeError(`Fit process response status is invalid: ${String(value['status'])}`);
    }
}
/**
 * Absolute path to the one-shot runner, to be spawned with a Bare executable.
 *
 * The child reads one request line on stdin and writes one response line on
 * stdout. Supervisors must key off that line rather than the exit code, and are
 * responsible for the deadline the runner does not impose: see "What the parent
 * observes" in the package README for the full set of outcomes.
 *
 * Resolved on demand so hosts without subprocess support can import the
 * protocol and refuse the feature before the runner entrypoint is looked up.
 */
function resolveFitProcessRunnerPath() {
    return require.resolve('./process-runner.js');
}
