"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AudioGenInterface = exports.RepaintMode = exports.AudioEditOperationType = void 0;
/** Stable string values serialized across the JS -> native addon boundary. */
var AudioEditOperationType;
(function (AudioEditOperationType) {
    AudioEditOperationType["FlowEdit"] = "flow-edit";
    AudioEditOperationType["Repaint"] = "repaint";
})(AudioEditOperationType || (exports.AudioEditOperationType = AudioEditOperationType = {}));
var RepaintMode;
(function (RepaintMode) {
    RepaintMode["Conservative"] = "conservative";
    RepaintMode["Balanced"] = "balanced";
    RepaintMode["Aggressive"] = "aggressive";
})(RepaintMode || (exports.RepaintMode = RepaintMode = {}));
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
        return this._binding.runJob(this._handle, data);
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
