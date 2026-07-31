"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ERR_CODES = exports.QvacErrorAddonMarian = void 0;
/* eslint-disable @typescript-eslint/no-require-imports -- @qvac/error exposes a CommonJS export shape. */
const QvacError = require("@qvac/error");
/* eslint-enable @typescript-eslint/no-require-imports */
const { QvacErrorBase, addCodes } = QvacError;
class QvacErrorAddonMarian extends QvacErrorBase {
}
exports.QvacErrorAddonMarian = QvacErrorAddonMarian;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- package metadata is read from the package root at runtime.
const { name, version } = require("../package.json");
// This library has error code range from 8001 to 9000
exports.ERR_CODES = Object.freeze({
    FAILED_TO_LOAD_WEIGHTS: 8001,
    FAILED_TO_CANCEL: 8002,
    FAILED_TO_APPEND: 8003,
    FAILED_TO_GET_STATUS: 8004,
    FAILED_TO_DESTROY: 8005,
    FAILED_TO_ACTIVATE: 8006,
    FAILED_TO_RESET: 8007,
    FAILED_TO_PAUSE: 8008,
    FAILED_TO_GET_BACKEND_NAME: 8009,
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
        message: (message) => `Failed to append data to processing queue, error: ${message}`,
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
    [exports.ERR_CODES.FAILED_TO_GET_BACKEND_NAME]: {
        name: "FAILED_TO_GET_BACKEND_NAME",
        message: (message) => `Failed to get active backend name, error: ${message}`,
    },
}, {
    name,
    version,
});
