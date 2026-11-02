"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateParakeetBackend = validateParakeetBackend;
exports.validateSpeakerAttribution = validateSpeakerAttribution;
const error_1 = require("../../lib/error");
const ATTRIBUTION_KEYS = [
    "modelPath",
    "mergeSameSpeaker",
    "minSegmentMs",
    "padSegmentMs",
];
const NATIVE_INT_MAX = 2147483647;
function invalidConfig(message) {
    throw new error_1.QvacErrorAddonASRGgml({
        code: error_1.ERR_CODES_PARAKEET.INVALID_CONFIG,
        adds: message,
    });
}
function validateParakeetBackend(backend) {
    if (backend !== undefined && typeof backend !== "string") {
        invalidConfig("parakeetConfig.backend must be a string");
    }
}
function validateAttributionKeys(config) {
    for (const key of Object.keys(config)) {
        if (!ATTRIBUTION_KEYS.includes(key)) {
            invalidConfig(`${key} is not a valid speakerAttribution parameter`);
        }
    }
}
function validateNativeInteger(value, key) {
    if (value === undefined)
        return;
    if (typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > NATIVE_INT_MAX) {
        invalidConfig(`speakerAttribution.${key} must be a non-negative native integer`);
    }
}
function validateSpeakerAttribution(config) {
    if (config === undefined)
        return;
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
        invalidConfig("speakerAttribution must be a configuration object");
    }
    const options = config;
    validateAttributionKeys(options);
    if (typeof options.modelPath !== "string" || !options.modelPath.trim()) {
        invalidConfig("speakerAttribution.modelPath must be a non-empty string");
    }
    if (options.mergeSameSpeaker !== undefined &&
        typeof options.mergeSameSpeaker !== "boolean") {
        invalidConfig("speakerAttribution.mergeSameSpeaker must be a boolean");
    }
    validateNativeInteger(options.minSegmentMs, "minSegmentMs");
    validateNativeInteger(options.padSegmentMs, "padSegmentMs");
}
