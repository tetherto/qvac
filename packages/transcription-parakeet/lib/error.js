"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.END_OF_INPUT = exports.ERR_CODES = exports.QvacErrorAddonParakeet = void 0;
/* eslint-disable @typescript-eslint/no-require-imports -- @qvac/error exposes a CommonJS export shape. */
const QvacError = require("@qvac/error");
/* eslint-enable @typescript-eslint/no-require-imports */
const { QvacErrorBase, addCodes } = QvacError;
class QvacErrorAddonParakeet extends QvacErrorBase {
    constructor(options) {
        super(typeof options === "number" ? { code: options } : options);
    }
}
exports.QvacErrorAddonParakeet = QvacErrorAddonParakeet;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- package metadata is read from the package root at runtime.
const { name, version } = require("../package.json");
// This library has error code range from 24,001 to 25,000.
exports.ERR_CODES = Object.freeze({
    FAILED_TO_LOAD_WEIGHTS: 24001,
    FAILED_TO_CANCEL: 24002,
    FAILED_TO_APPEND: 24003,
    FAILED_TO_GET_STATUS: 24004,
    FAILED_TO_DESTROY: 24005,
    FAILED_TO_ACTIVATE: 24006,
    FAILED_TO_RESET: 24007,
    FAILED_TO_PAUSE: 24008,
    MODEL_NOT_FOUND: 24009,
    INVALID_AUDIO_FORMAT: 24010,
    INVALID_CONFIG: 24015,
    JOB_ALREADY_RUNNING: 24016,
    BUFFER_LIMIT_EXCEEDED: 24017,
    INSTANCE_DESTROYED: 24018,
    JOB_CANCELLED: 24019,
});
addCodes({
    [exports.ERR_CODES.FAILED_TO_LOAD_WEIGHTS]: {
        name: "FAILED_TO_LOAD_WEIGHTS",
        message: (message) => `Failed to load weights, error: ${message}`,
    },
    [exports.ERR_CODES.FAILED_TO_CANCEL]: {
        name: "FAILED_TO_CANCEL",
        message: (message) => `Failed to cancel inference, error: ${message}`,
    },
    [exports.ERR_CODES.FAILED_TO_APPEND]: {
        name: "FAILED_TO_APPEND",
        message: (message) => `Failed to append audio data to processing queue, error: ${message}`,
    },
    [exports.ERR_CODES.FAILED_TO_GET_STATUS]: {
        name: "FAILED_TO_GET_STATUS",
        message: (message) => `Failed to get addon status, error: ${message}`,
    },
    [exports.ERR_CODES.FAILED_TO_DESTROY]: {
        name: "FAILED_TO_DESTROY",
        message: (message) => `Failed to destroy instance, error: ${message}`,
    },
    [exports.ERR_CODES.FAILED_TO_ACTIVATE]: {
        name: "FAILED_TO_ACTIVATE",
        message: (message) => `Failed to activate model, error: ${message}`,
    },
    [exports.ERR_CODES.FAILED_TO_RESET]: {
        name: "FAILED_TO_RESET",
        message: (message) => `Failed to reset model state, error: ${message}`,
    },
    [exports.ERR_CODES.FAILED_TO_PAUSE]: {
        name: "FAILED_TO_PAUSE",
        message: (message) => `Failed to pause inference, error: ${message}`,
    },
    [exports.ERR_CODES.MODEL_NOT_FOUND]: {
        name: "MODEL_NOT_FOUND",
        message: (modelPath) => `Model not found at path: ${modelPath}`,
    },
    [exports.ERR_CODES.INVALID_AUDIO_FORMAT]: {
        name: "INVALID_AUDIO_FORMAT",
        message: (format) => `Invalid audio format: ${format}. Expected 16kHz mono audio.`,
    },
    [exports.ERR_CODES.INVALID_CONFIG]: {
        name: "INVALID_CONFIG",
        message: (message) => `Invalid configuration: ${message}`,
    },
    [exports.ERR_CODES.JOB_ALREADY_RUNNING]: {
        name: "JOB_ALREADY_RUNNING",
        message: () => "Cannot set new job: a job is already set or being processed",
    },
    [exports.ERR_CODES.BUFFER_LIMIT_EXCEEDED]: {
        name: "BUFFER_LIMIT_EXCEEDED",
        message: (message) => `Audio buffer size limit exceeded: ${message}`,
    },
    [exports.ERR_CODES.INSTANCE_DESTROYED]: {
        name: "INSTANCE_DESTROYED",
        message: () => "Cannot load: instance has been destroyed",
    },
    [exports.ERR_CODES.JOB_CANCELLED]: {
        name: "JOB_CANCELLED",
        message: () => "Job cancelled",
    },
}, { name, version });
exports.END_OF_INPUT = "end of job";
