"use strict";
// Thin JS <-> C++ boundary for the ACE-Step music addon, mirroring
// tts-ggml/src/tts.ts. `AudioGenInterface` owns the native handle and forwards
// createInstance / activate / runJob / cancel / destroyInstance to the binding.
Object.defineProperty(exports, "__esModule", { value: true });
exports.AudioGenInterface = void 0;
/** An interface between the Bare addon in C++ and the JS runtime. */
class AudioGenInterface {
    _binding;
    _handle;
    constructor(binding, configuration = {}, outputCallback = null) {
        this._binding = binding;
        this._handle = this._binding.createInstance(this, configuration, outputCallback);
    }
    async activate() {
        return this._binding.activate(this._handle);
    }
    async runJob(data) {
        await this._binding.runJob(this._handle, data);
    }
    async cancel() {
        return this._binding.cancel(this._handle);
    }
    async destroyInstance() {
        if (this._handle === null)
            return;
        const handle = this._handle;
        this._handle = null;
        await this._binding.destroyInstance(handle);
    }
}
exports.AudioGenInterface = AudioGenInterface;
