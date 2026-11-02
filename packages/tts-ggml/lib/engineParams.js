"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildNativeParams = buildNativeParams;
const engineIds_1 = require("./engineIds");
const audio8_1 = require("./engines/audio8");
const chatterbox_1 = require("./engines/chatterbox");
const cosyvoice_1 = require("./engines/cosyvoice");
const moss_1 = require("./engines/moss");
const mossSoundEffect_1 = require("./engines/mossSoundEffect");
const mossSpeech_1 = require("./engines/mossSpeech");
const parler_1 = require("./engines/parler");
const supertonic_1 = require("./engines/supertonic");
function buildNativeParams(setup) {
    if (setup.pocket)
        return { ...setup.pocket.params };
    switch (setup.engineType) {
        case engineIds_1.ENGINE_SUPERTONIC:
            return (0, supertonic_1.buildSupertonicParams)(setup);
        case engineIds_1.ENGINE_COSYVOICE3:
            return (0, cosyvoice_1.buildCosyvoiceParams)(setup);
        case engineIds_1.ENGINE_PARLER:
            return (0, parler_1.buildParlerParams)(setup);
        case engineIds_1.ENGINE_AUDIO8:
            return (0, audio8_1.buildAudio8Params)(setup);
        case engineIds_1.ENGINE_MOSS:
            return (0, moss_1.buildMossParams)(setup);
        case engineIds_1.ENGINE_MOSS_SFX:
            return (0, mossSoundEffect_1.buildMossSoundEffectParams)(setup);
        case engineIds_1.ENGINE_MOSS_SPEECH:
            return (0, mossSpeech_1.buildMossSpeechParams)(setup);
        default:
            return (0, chatterbox_1.buildChatterboxParams)(setup);
    }
}
