"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FABRIC_ENGINE_TYPES = exports.SAMPLING_ENGINES = exports.ENGINE_TYPES = exports.ENGINE_POCKET = exports.ENGINE_MOSS_SPEECH = exports.ENGINE_MOSS_SFX = exports.ENGINE_MOSS = exports.ENGINE_AUDIO8 = exports.ENGINE_PARLER = exports.ENGINE_COSYVOICE3 = exports.ENGINE_SUPERTONIC = exports.ENGINE_CHATTERBOX = void 0;
exports.isEngineType = isEngineType;
exports.ENGINE_CHATTERBOX = "chatterbox";
exports.ENGINE_SUPERTONIC = "supertonic";
// CosyVoice3 (Fun-CosyVoice3-0.5B / 1.5B). Ships as a small set of GGUFs
// (cosyvoice3-{llm,flow,hift}-*.gguf) plus voice.gguf, vocab.json and
// merges.txt; a modelDir holding them (or an explicit
// `files.cosyvoiceModelDir`) routes here.
exports.ENGINE_COSYVOICE3 = "cosyvoice3";
exports.ENGINE_PARLER = "parler";
exports.ENGINE_AUDIO8 = "audio8";
exports.ENGINE_MOSS = "moss";
exports.ENGINE_MOSS_SFX = "moss-sfx";
exports.ENGINE_MOSS_SPEECH = "moss-speech";
exports.ENGINE_POCKET = "pocket";
exports.ENGINE_TYPES = [
    exports.ENGINE_CHATTERBOX,
    exports.ENGINE_SUPERTONIC,
    exports.ENGINE_COSYVOICE3,
    exports.ENGINE_PARLER,
    exports.ENGINE_AUDIO8,
    exports.ENGINE_MOSS,
    exports.ENGINE_MOSS_SFX,
    exports.ENGINE_MOSS_SPEECH,
    exports.ENGINE_POCKET,
];
function isEngineType(value) {
    return (typeof value === "string" &&
        exports.ENGINE_TYPES.includes(value));
}
/** Engines that draw tokens, and so accept temperature / topK / topP / maxFrames. */
exports.SAMPLING_ENGINES = [exports.ENGINE_PARLER, exports.ENGINE_AUDIO8];
// tts-cpp engine names (tts-cpp/voice_controls.h engine_name) that differ from
// this package's engine types.
exports.FABRIC_ENGINE_TYPES = {
    cosyvoice: exports.ENGINE_COSYVOICE3,
};
