"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toVoiceControlsCatalog = toVoiceControlsCatalog;
const engineIds_1 = require("./engineIds");
/**
 * Copies the native catalog so callers cannot change the binding's tables.
 * tts-cpp's `cosyvoice` appears as `cosyvoice3`; an engine this package does
 * not wrap keeps its tts-cpp name.
 */
function toVoiceControlsCatalog(native) {
    const engines = {};
    for (const [name, controls] of Object.entries(native.engines)) {
        engines[engineIds_1.FABRIC_ENGINE_TYPES[name] ?? name] = {
            emotions: [...controls.emotions],
            paces: [...controls.paces],
        };
    }
    return {
        emotions: [...native.emotions],
        paces: [...native.paces],
        engines,
    };
}
