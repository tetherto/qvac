"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ERR_CODES = exports.QvacErrorAddonOcrGgml = void 0;
exports.errorMessage = errorMessage;
/* eslint-disable @typescript-eslint/no-require-imports -- @qvac/error exposes a CommonJS export shape. */
const QvacError = require("@qvac/error");
/* eslint-enable @typescript-eslint/no-require-imports */
const { QvacErrorBase, addCodes } = QvacError;
class QvacErrorAddonOcrGgml extends QvacErrorBase {
}
exports.QvacErrorAddonOcrGgml = QvacErrorAddonOcrGgml;
/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err) {
    if (err instanceof Error)
        return err.message;
    if (err && typeof err === "object" && "message" in err) {
        const message = err.message;
        if (typeof message === "string" && message)
            return message;
    }
    return typeof err === "string" ? err : "unknown error";
}
// eslint-disable-next-line @typescript-eslint/no-require-imports -- package metadata is read from the package root at runtime.
const { name, version } = require("../package.json");
// Allocated error code range: 8101..8200
// (translation-nmtcpp uses 8001..9000 broadly; ocr-onnx claims its own block.)
exports.ERR_CODES = Object.freeze({
    FAILED_TO_LOAD_WEIGHTS: 8101,
    FAILED_TO_CANCEL: 8102,
    FAILED_TO_RUN_JOB: 8103,
    FAILED_TO_GET_STATUS: 8104,
    FAILED_TO_DESTROY: 8105,
    FAILED_TO_ACTIVATE: 8106,
    MISSING_REQUIRED_PARAMETER: 8107,
    UNSUPPORTED_LANGUAGE: 8108,
    INVALID_IMAGE_OR_INSUFFICIENT_DATA: 8109,
    UNSUPPORTED_IMAGE_FORMAT: 8110,
    NOT_LOADED: 8111,
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
    [exports.ERR_CODES.FAILED_TO_RUN_JOB]: {
        name: "FAILED_TO_RUN_JOB",
        message: (message) => `Failed to run OCR job, error: ${message}`,
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
    [exports.ERR_CODES.MISSING_REQUIRED_PARAMETER]: {
        name: "MISSING_REQUIRED_PARAMETER",
        message: (message) => `Missing required parameter: ${message}`,
    },
    [exports.ERR_CODES.UNSUPPORTED_LANGUAGE]: {
        name: "UNSUPPORTED_LANGUAGE",
        message: (message) => `Unsupported language(s): ${message}`,
    },
    [exports.ERR_CODES.INVALID_IMAGE_OR_INSUFFICIENT_DATA]: {
        name: "INVALID_IMAGE_OR_INSUFFICIENT_DATA",
        message: (message) => `Invalid image file or insufficient data: ${message}`,
    },
    [exports.ERR_CODES.UNSUPPORTED_IMAGE_FORMAT]: {
        name: "UNSUPPORTED_IMAGE_FORMAT",
        message: (message) => `Unsupported image format: ${message}`,
    },
    [exports.ERR_CODES.NOT_LOADED]: {
        name: "NOT_LOADED",
        message: (message) => `OCR model is not loaded: ${message}`,
    },
}, {
    name,
    version,
});
