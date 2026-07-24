"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ERR_CODES = exports.QvacErrorAddonTTSGgml = void 0;
/* eslint-disable @typescript-eslint/no-require-imports -- @qvac/error exposes a CommonJS export shape. */
const QvacError = require("@qvac/error");
/* eslint-enable @typescript-eslint/no-require-imports */
const { QvacErrorBase, addCodes } = QvacError;
class QvacErrorAddonTTSGgml extends QvacErrorBase {
}
exports.QvacErrorAddonTTSGgml = QvacErrorAddonTTSGgml;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- package metadata is read from the package root at runtime.
const { name, version } = require("../package.json");
// This library has error code range from 13001 to 14000.
exports.ERR_CODES = Object.freeze({
    FAILED_TO_ACTIVATE: 13001,
    FAILED_TO_APPEND: 13002,
    FAILED_TO_GET_STATUS: 13003,
    FAILED_TO_PAUSE: 13004,
    FAILED_TO_CANCEL: 13005,
    FAILED_TO_DESTROY: 13006,
    FAILED_TO_UNLOAD: 13007,
    FAILED_TO_LOAD: 13008,
    FAILED_TO_RELOAD: 13009,
    FAILED_TO_STOP: 13010,
    JOB_ALREADY_RUNNING: 13011,
});
addCodes({
    [exports.ERR_CODES.FAILED_TO_ACTIVATE]: {
        name: "FAILED_TO_ACTIVATE",
        message: (message) => `Failed to activate model, error: ${message}`,
    },
    [exports.ERR_CODES.FAILED_TO_APPEND]: {
        name: "FAILED_TO_APPEND",
        message: (message) => `Failed to append data to processing queue, error: ${message}`,
    },
    [exports.ERR_CODES.FAILED_TO_GET_STATUS]: {
        name: "FAILED_TO_GET_STATUS",
        message: (message) => `Failed to get addon status, error: ${message}`,
    },
    [exports.ERR_CODES.FAILED_TO_PAUSE]: {
        name: "FAILED_TO_PAUSE",
        message: (message) => `Failed to pause inference, error: ${message}`,
    },
    [exports.ERR_CODES.FAILED_TO_CANCEL]: {
        name: "FAILED_TO_CANCEL",
        message: (message) => `Failed to cancel inference, error: ${message}`,
    },
    [exports.ERR_CODES.FAILED_TO_DESTROY]: {
        name: "FAILED_TO_DESTROY",
        message: (message) => `Failed to destroy instance, error: ${message}`,
    },
    [exports.ERR_CODES.FAILED_TO_UNLOAD]: {
        name: "FAILED_TO_UNLOAD",
        message: (message) => `Failed to unload model, error: ${message}`,
    },
    [exports.ERR_CODES.FAILED_TO_LOAD]: {
        name: "FAILED_TO_LOAD",
        message: (message) => `Failed to load model, error: ${message}`,
    },
    [exports.ERR_CODES.FAILED_TO_RELOAD]: {
        name: "FAILED_TO_RELOAD",
        message: (message) => `Failed to reload model, error: ${message}`,
    },
    [exports.ERR_CODES.FAILED_TO_STOP]: {
        name: "FAILED_TO_STOP",
        message: (message) => `Failed to stop inference, error: ${message}`,
    },
    [exports.ERR_CODES.JOB_ALREADY_RUNNING]: {
        name: "JOB_ALREADY_RUNNING",
        message: () => "Cannot set new job: a job is already set or being processed",
    },
}, { name, version });
