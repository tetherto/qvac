"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LlmSglangInterface = void 0;
exports.mapAddonEvent = mapAddonEvent;
/**
 * Normalize a native event into Output, Error, or JobEnded. String payloads
 * are token deltas. A plain object is the terminal runtime-stats snapshot.
 */
function mapAddonEvent(rawEvent, rawData, rawError) {
    if (typeof rawEvent === 'string' && rawEvent.includes('LogMsg')) {
        return null;
    }
    if (typeof rawEvent === 'string' && rawEvent.includes('Error')) {
        return { type: 'Error', data: rawData, error: rawError };
    }
    if (typeof rawData === 'string') {
        return { type: 'Output', data: rawData, error: null };
    }
    if (rawData && typeof rawData === 'object') {
        return { type: 'JobEnded', data: rawData, error: null };
    }
    if (typeof rawEvent === 'string' && rawEvent.includes('JobEnded')) {
        return { type: 'JobEnded', data: rawData, error: null };
    }
    return null;
}
class LlmSglangInterface {
    binding;
    handle;
    constructor(binding, configurationParams, outputCallback) {
        this.binding = binding;
        this.handle = this.binding.createInstance(this, configurationParams, outputCallback);
    }
    activate() {
        if (!this.handle) {
            throw new Error('SGLang addon is not initialized');
        }
        this.binding.activate(this.handle);
        return Promise.resolve();
    }
    async runJob(input) {
        if (!this.handle) {
            throw new Error('SGLang addon is not initialized');
        }
        return this.binding.runJob(this.handle, input);
    }
    async cancel() {
        if (!this.handle)
            return;
        await this.binding.cancel(this.handle);
    }
    unload() {
        if (this.handle === null)
            return Promise.resolve();
        try {
            this.binding.destroyInstance(this.handle);
        }
        finally {
            this.handle = null;
        }
        return Promise.resolve();
    }
}
exports.LlmSglangInterface = LlmSglangInterface;
