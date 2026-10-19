"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyReloadableConfig = applyReloadableConfig;
const conditioning_1 = require("./conditioning");
const engineParams_1 = require("./engineParams");
const audio8_1 = require("./engines/audio8");
const moss_1 = require("./engines/moss");
const parler_1 = require("./engines/parler");
const setup_1 = require("./setup");
function captureReloadableState(setup) {
    return {
        language: setup.config.language,
        useGPU: setup.config.useGPU,
        outputSampleRate: setup.outputSampleRate,
        settings: { ...setup.settings },
    };
}
function restoreReloadableState(setup, state) {
    setup.config.language = state.language;
    setup.config.useGPU = state.useGPU;
    setup.outputSampleRate = state.outputSampleRate;
    const live = setup.settings;
    const snapshot = state.settings;
    for (const key of new Set([...Object.keys(live), ...Object.keys(snapshot)])) {
        live[key] = snapshot[key];
    }
}
function applyReloadableRuntimeConfig(setup, newConfig) {
    (0, moss_1.assertMossReloadKeepsVoice)(setup, newConfig);
    const runtimeConfig = newConfig;
    if (runtimeConfig.language !== undefined) {
        setup.config.language = runtimeConfig.language;
    }
    if (runtimeConfig.useGPU !== undefined) {
        setup.config.useGPU = runtimeConfig.useGPU;
    }
    if (runtimeConfig.outputSampleRate !== undefined) {
        setup.outputSampleRate = (0, setup_1.validateOutputSampleRate)(runtimeConfig.outputSampleRate);
    }
    (0, audio8_1.applyAudio8Reload)(setup, newConfig);
    (0, moss_1.applyMossReload)(setup, newConfig);
}
// Cross-engine conditioning is reloadable on every engine that supports it,
// so both families change emotion the same way.
function applyReloadableConditioning(setup, newConfig) {
    const conditioning = newConfig;
    if (conditioning.emotion === undefined &&
        conditioning.pace === undefined) {
        return;
    }
    if (conditioning.emotion !== undefined) {
        setup.settings.emotion = conditioning.emotion;
    }
    if (conditioning.pace !== undefined) {
        setup.settings.pace = conditioning.pace;
    }
    (0, conditioning_1.assertConditioningConsistency)(setup, "reload");
}
/**
 * Apply the new configuration and build the native parameters from it. A
 * rejected value leaves the instance exactly as it was, so a later partial
 * reload is not validated against state the caller never accepted.
 */
function applyReloadableConfig(setup, newConfig) {
    const snapshot = captureReloadableState(setup);
    try {
        applyReloadableRuntimeConfig(setup, newConfig);
        applyReloadableConditioning(setup, newConfig);
        (0, parler_1.applyParlerReload)(setup, newConfig);
        return (0, engineParams_1.buildNativeParams)(setup);
    }
    catch (error) {
        restoreReloadableState(setup, snapshot);
        throw error;
    }
}
