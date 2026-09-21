"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ERR_CODES = exports.ERR_CODE_RANGE = exports.QvacErrorAudioGen = void 0;
/* eslint-disable @typescript-eslint/no-require-imports -- @qvac/error exposes a CommonJS export shape. */
const QvacError = require("@qvac/error");
/* eslint-enable @typescript-eslint/no-require-imports */
const { QvacErrorBase, addCodes } = QvacError;
class QvacErrorAudioGen extends QvacErrorBase {
}
exports.QvacErrorAudioGen = QvacErrorAudioGen;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- package metadata is read from the package root at runtime.
const { name, version } = require('./package.json');
exports.ERR_CODE_RANGE = Object.freeze({
    start: 31001,
    end: 32000
});
exports.ERR_CODES = Object.freeze({
    INVALID_INPUT: exports.ERR_CODE_RANGE.start,
    NOT_LOADED: 31002,
    CANCELLED: 31003,
    MODEL_UNLOADED: 31004,
    INSTANCE_DESTROYED: 31005,
    JOB_ALREADY_RUNNING: 31006,
    FAILED_TO_START_JOB: 31007,
    FAILED_TO_CANCEL: 31008,
    FAILED_TO_DESTROY: 31009,
    FAILED_TO_LOAD: 31010,
    INFERENCE_FAILED: 31011
});
addCodes({
    [exports.ERR_CODES.INVALID_INPUT]: {
        name: 'INVALID_INPUT',
        message: (message) => `Invalid AudioGen input: ${message}`
    },
    [exports.ERR_CODES.NOT_LOADED]: {
        name: 'NOT_LOADED',
        message: () => 'AudioGen is not loaded. Call load() first.'
    },
    [exports.ERR_CODES.CANCELLED]: {
        name: 'CANCELLED',
        message: () => 'AudioGen run was cancelled'
    },
    [exports.ERR_CODES.MODEL_UNLOADED]: {
        name: 'MODEL_UNLOADED',
        message: () => 'AudioGen was unloaded'
    },
    [exports.ERR_CODES.INSTANCE_DESTROYED]: {
        name: 'INSTANCE_DESTROYED',
        message: () => 'AudioGen instance was destroyed'
    },
    [exports.ERR_CODES.JOB_ALREADY_RUNNING]: {
        name: 'JOB_ALREADY_RUNNING',
        message: () => 'Native AudioGen job admission was rejected'
    },
    [exports.ERR_CODES.FAILED_TO_START_JOB]: {
        name: 'FAILED_TO_START_JOB',
        message: (message) => `Failed to start AudioGen job: ${message}`
    },
    [exports.ERR_CODES.FAILED_TO_CANCEL]: {
        name: 'FAILED_TO_CANCEL',
        message: (message) => `Failed to cancel AudioGen run: ${message}`
    },
    [exports.ERR_CODES.FAILED_TO_DESTROY]: {
        name: 'FAILED_TO_DESTROY',
        message: (message) => `Failed to destroy AudioGen instance: ${message}`
    },
    [exports.ERR_CODES.FAILED_TO_LOAD]: {
        name: 'FAILED_TO_LOAD',
        message: (message) => `Failed to load AudioGen instance: ${message}`
    },
    [exports.ERR_CODES.INFERENCE_FAILED]: {
        name: 'INFERENCE_FAILED',
        message: (message) => `AudioGen inference failed: ${message}`
    }
}, { name, version });
