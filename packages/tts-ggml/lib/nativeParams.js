"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignSamplingParams = assignSamplingParams;
exports.assignBackendParams = assignBackendParams;
exports.assignCommonNativeParams = assignCommonNativeParams;
exports.assignLavasrParams = assignLavasrParams;
/** The knobs every engine in SAMPLING_ENGINES reads. */
function assignSamplingParams(setup, parameters) {
    if (setup.settings.temperature != null) {
        parameters.temperature = Number(setup.settings.temperature);
    }
    if (setup.settings.topK != null)
        parameters.topK = setup.settings.topK | 0;
    if (setup.settings.topP != null)
        parameters.topP = Number(setup.settings.topP);
    if (setup.settings.maxFrames != null) {
        parameters.maxFrames = setup.settings.maxFrames | 0;
    }
}
/**
 * Backend and output plumbing for the engines that take no `language`,
 * where `assignCommonNativeParams` would be the wrong shape.
 */
function assignBackendParams(setup, parameters) {
    if (setup.settings.seed != null)
        parameters.seed = setup.settings.seed | 0;
    if (setup.settings.threads != null)
        parameters.threads = setup.settings.threads | 0;
    if (setup.outputSampleRate != null) {
        parameters.outputSampleRate = setup.outputSampleRate | 0;
    }
    if (setup.settings.nGpuLayers != null) {
        parameters.nGpuLayers = setup.settings.nGpuLayers | 0;
    }
    if (setup.config.useGPU != null) {
        parameters.useGPU = !!setup.config.useGPU;
    }
    assignLavasrParams(setup, parameters);
    if (setup.backend.backendsDir) {
        parameters.backendsDir = setup.backend.backendsDir;
    }
}
function assignCommonNativeParams(setup, parameters) {
    if (setup.settings.seed != null)
        parameters.seed = setup.settings.seed | 0;
    if (setup.settings.threads != null)
        parameters.threads = setup.settings.threads | 0;
    if (setup.settings.nGpuLayers != null) {
        parameters.nGpuLayers = setup.settings.nGpuLayers | 0;
    }
    if (setup.outputSampleRate != null) {
        parameters.outputSampleRate = setup.outputSampleRate | 0;
    }
    if (setup.config.useGPU != null) {
        parameters.useGPU = !!setup.config.useGPU;
    }
    assignLavasrParams(setup, parameters);
    if (setup.backend.backendsDir) {
        parameters.backendsDir = setup.backend.backendsDir;
    }
    if (setup.backend.openclCacheDir) {
        parameters.openclCacheDir = setup.backend.openclCacheDir;
    }
}
/** LavaSR post-processing paths, shared by every engine that supports them. */
function assignLavasrParams(setup, parameters) {
    if (setup.backend.enhancerGgufPath) {
        parameters.lavasrEnhancerPath = setup.backend.enhancerGgufPath;
    }
    if (setup.backend.denoiserGgufPath) {
        parameters.lavasrDenoiserPath = setup.backend.denoiserGgufPath;
    }
}
