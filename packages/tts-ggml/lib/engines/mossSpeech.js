"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MOSS_SPEECH_CONTROL_KEYS = exports.MOSS_SPEECH_ONLY_KEYS = exports.MOSS_SPEECH_ROLES = exports.MOSS_SPEECH_MAX_TOP_P = exports.MOSS_SPEECH_MAX_TEMPERATURE = exports.MOSS_SPEECH_MAX_REPLY_SECONDS = exports.MOSS_SPEECH_MAX_NEW_TOKENS = exports.MOSS_SPEECH_MAX_SAMPLE_RATE = exports.MOSS_SPEECH_MIN_SAMPLE_RATE = exports.MOSS_SPEECH_NATIVE_SAMPLE_RATE = exports.MOSS_SPEECH_CODEC_RE = exports.MOSS_SPEECH_RE = void 0;
exports.assertSpeechCall = assertSpeechCall;
exports.pickSpeechFields = pickSpeechFields;
exports.resolveMossSpeechModelPaths = resolveMossSpeechModelPaths;
exports.assertMossSpeechOptions = assertMossSpeechOptions;
exports.resolveSpeechJobFields = resolveSpeechJobFields;
exports.buildMossSpeechParams = buildMossSpeechParams;
const engineIds_1 = require("../engineIds");
const modelFiles_1 = require("../modelFiles");
const nativeParams_1 = require("../nativeParams");
exports.MOSS_SPEECH_RE = /^moss-speech(-(?!codec)[a-z0-9_]+)?\.gguf$/i;
exports.MOSS_SPEECH_CODEC_RE = /^moss-speech-codec(-[a-z0-9_]+)?\.gguf$/i;
exports.MOSS_SPEECH_NATIVE_SAMPLE_RATE = 24000;
exports.MOSS_SPEECH_MIN_SAMPLE_RATE = 8000;
exports.MOSS_SPEECH_MAX_SAMPLE_RATE = 192000;
exports.MOSS_SPEECH_MAX_NEW_TOKENS = 4096;
exports.MOSS_SPEECH_MAX_REPLY_SECONDS = 3600;
exports.MOSS_SPEECH_MAX_TEMPERATURE = 10;
exports.MOSS_SPEECH_MAX_TOP_P = 1;
exports.MOSS_SPEECH_ROLES = ["system", "user", "assistant"];
exports.MOSS_SPEECH_ONLY_KEYS = [
    "audio",
    "sampleRate",
    "messages",
    "systemPrompt",
    "replyVoice",
    "replyVoiceSampleRate",
    "textReply",
    "maxReplySeconds",
    "maxNewTokens",
];
exports.MOSS_SPEECH_CONTROL_KEYS = [
    "textReply",
    "maxReplySeconds",
    "maxNewTokens",
    "greedy",
    "temperature",
    "topP",
    "topK",
];
function isSpeechPcm(value) {
    return value instanceof Int16Array || value instanceof Float32Array;
}
function assertSpeechSampleRate(value, name, where) {
    if (typeof value === "number" &&
        Number.isInteger(value) &&
        value >= exports.MOSS_SPEECH_MIN_SAMPLE_RATE &&
        value <= exports.MOSS_SPEECH_MAX_SAMPLE_RATE) {
        return;
    }
    throw new Error(`tts-ggml: ${where}: moss-speech ${name} must be an integer in ` +
        `[${exports.MOSS_SPEECH_MIN_SAMPLE_RATE}, ${exports.MOSS_SPEECH_MAX_SAMPLE_RATE}] (got ${String(value)})`);
}
function assertSpeechAudio(audio, rate, names, where) {
    if (!isSpeechPcm(audio) || audio.length === 0) {
        throw new Error(`tts-ggml: ${where}: moss-speech ${names[0]} must be a non-empty Int16Array or Float32Array`);
    }
    assertSpeechSampleRate(rate, names[1], where);
}
function assertSpeechMessage(message, index, where) {
    const label = `messages[${index}]`;
    if (message == null || typeof message !== "object") {
        throw new Error(`tts-ggml: ${where}: moss-speech ${label} must be an object`);
    }
    const turn = message;
    if (!exports.MOSS_SPEECH_ROLES.includes(turn.role)) {
        throw new Error(`tts-ggml: ${where}: moss-speech ${label}.role must be one of ${exports.MOSS_SPEECH_ROLES.join(", ")}`);
    }
    const hasText = typeof turn.text === "string" && turn.text.length > 0;
    const hasAudio = turn.audio !== undefined;
    if (hasText === hasAudio) {
        throw new Error(`tts-ggml: ${where}: moss-speech ${label} carries exactly one of text or audio`);
    }
    if (hasAudio) {
        assertSpeechAudio(turn.audio, turn.sampleRate, [`${label}.audio`, `${label}.sampleRate`], where);
    }
}
function assertSpeechMessages(messages, where) {
    if (messages === undefined)
        return;
    if (!Array.isArray(messages)) {
        throw new Error(`tts-ggml: ${where}: moss-speech messages must be an array`);
    }
    assertEachSpeechMessage(messages, where);
}
function assertEachSpeechMessage(messages, where) {
    messages.forEach((message, index) => assertSpeechMessage(message, index, where));
}
function assertSpeechUserTurn(fields, where) {
    const hasText = typeof fields.input === "string" && fields.input.trim().length > 0;
    const hasAudio = fields.audio !== undefined;
    if (hasText && hasAudio) {
        throw new Error(`tts-ggml: ${where}: moss-speech takes the user turn as audio or input text, not both`);
    }
    if (hasAudio) {
        assertSpeechAudio(fields.audio, fields.sampleRate, ["audio", "sampleRate"], where);
        return;
    }
    if (!hasText) {
        throw new Error(`tts-ggml: ${where}: moss-speech needs the user turn as audio (with sampleRate) or input text`);
    }
}
function assertSpeechRange(name, value, accepts, range, where) {
    if (value === undefined)
        return;
    if (typeof value === "number" && Number.isFinite(value) && accepts(value))
        return;
    const got = typeof value === "number" ? String(value) : typeof value;
    throw new Error(`tts-ggml: ${where}: moss-speech ${name} must be ${range} (got ${got})`);
}
function assertSpeechControls(fields, where) {
    assertSpeechRange("maxReplySeconds", fields.maxReplySeconds, (n) => n >= 0 && n <= exports.MOSS_SPEECH_MAX_REPLY_SECONDS, `in [0, ${exports.MOSS_SPEECH_MAX_REPLY_SECONDS}]`, where);
    assertSpeechRange("maxNewTokens", fields.maxNewTokens, (n) => Number.isInteger(n) && n >= 1 && n <= exports.MOSS_SPEECH_MAX_NEW_TOKENS, `an integer in [1, ${exports.MOSS_SPEECH_MAX_NEW_TOKENS}]`, where);
    assertSpeechRange("temperature", fields.temperature, (n) => n > 0 && n <= exports.MOSS_SPEECH_MAX_TEMPERATURE, `in (0, ${exports.MOSS_SPEECH_MAX_TEMPERATURE}]`, where);
    assertSpeechRange("topP", fields.topP, (n) => n > 0 && n <= exports.MOSS_SPEECH_MAX_TOP_P, `in (0, ${exports.MOSS_SPEECH_MAX_TOP_P}]`, where);
    assertSpeechRange("topK", fields.topK, (n) => Number.isInteger(n) && n >= 0, "an integer >= 0", where);
    assertSpeechBooleans(fields, where);
    if (fields.systemPrompt !== undefined && typeof fields.systemPrompt !== "string") {
        throw new Error(`tts-ggml: ${where}: moss-speech systemPrompt must be a string`);
    }
}
function assertSpeechBooleans(fields, where) {
    for (const flag of ["textReply", "greedy"]) {
        if (fields[flag] !== undefined && typeof fields[flag] !== "boolean") {
            throw new Error(`tts-ggml: ${where}: moss-speech ${flag} must be a boolean`);
        }
    }
}
function assertSpeechRateHasAudio(audio, rate, names, where) {
    if (audio !== undefined || rate === undefined)
        return;
    throw new Error(`tts-ggml: ${where}: moss-speech ${names[1]} needs ${names[0]}`);
}
function assertSpeechCall(fields, where) {
    assertSpeechUserTurn(fields, where);
    assertSpeechRateHasAudio(fields.audio, fields.sampleRate, ["audio", "sampleRate"], where);
    assertSpeechRateHasAudio(fields.replyVoice, fields.replyVoiceSampleRate, ["replyVoice", "replyVoiceSampleRate"], where);
    assertSpeechMessages(fields.messages, where);
    if (fields.replyVoice !== undefined) {
        assertSpeechAudio(fields.replyVoice, fields.replyVoiceSampleRate, ["replyVoice", "replyVoiceSampleRate"], where);
    }
    assertSpeechControls(fields, where);
}
function speechUserTurn(fields) {
    if (fields.audio !== undefined) {
        return { role: "user", audio: fields.audio, sampleRate: fields.sampleRate };
    }
    return { role: "user", text: fields.input };
}
function speechMessages(fields) {
    const system = fields.systemPrompt ? [{ role: "system", text: fields.systemPrompt }] : [];
    return [...system, ...(fields.messages ?? []), speechUserTurn(fields)];
}
function speechReplyVoice(fields) {
    if (fields.replyVoice === undefined)
        return {};
    return { replyVoice: fields.replyVoice, replyVoiceSampleRate: fields.replyVoiceSampleRate };
}
function speechControls(fields) {
    const present = exports.MOSS_SPEECH_CONTROL_KEYS.filter((key) => fields[key] !== undefined);
    return Object.fromEntries(present.map((key) => [key, fields[key]]));
}
/** Collect the fields only MOSS-Speech reads that are present on `source`; undefined when none are set. */
function pickSpeechFields(source) {
    if (source == null || typeof source !== "object")
        return undefined;
    const present = exports.MOSS_SPEECH_ONLY_KEYS.filter((key) => source[key] !== undefined);
    if (present.length === 0)
        return undefined;
    return Object.fromEntries(present.map((key) => [key, source[key]]));
}
function resolveMossSpeechModelPaths(files) {
    return {
        mossSpeechModelPath: (0, modelFiles_1.firstNonEmpty)(files.mossSpeechModel, (0, modelFiles_1.findQuantRankedGguf)(files.modelDir, exports.MOSS_SPEECH_RE)),
        mossSpeechCodecPath: (0, modelFiles_1.firstNonEmpty)(files.mossSpeechCodec, (0, modelFiles_1.findQuantRankedGguf)(files.modelDir, exports.MOSS_SPEECH_CODEC_RE)),
    };
}
function assertMossSpeechOptions(setup) {
    if (setup.engineType !== engineIds_1.ENGINE_MOSS_SPEECH)
        return;
    if (setup.backend.enhancerGgufPath || setup.backend.denoiserGgufPath) {
        throw new Error("tts-ggml: the LavaSR enhancer/denoiser are not supported with " +
            "the moss-speech engine. Drop lavasrEnhancer / lavasrDenoiser.");
    }
    if (setup.settings.referenceAudio) {
        throw new Error("tts-ggml: the moss-speech engine takes its reply voice per call " +
            "(run({ replyVoice, replyVoiceSampleRate })), not referenceAudio");
    }
    assertMossSpeechOutputRate(setup);
    if (!setup.paths.mossSpeechModelPath || !setup.paths.mossSpeechCodecPath) {
        throw new Error("tts-ggml: the moss-speech engine needs its model and codec GGUFs: " +
            "stage moss-speech-*.gguf and moss-speech-codec-*.gguf in modelDir " +
            "or set files.mossSpeechModel and files.mossSpeechCodec");
    }
}
function assertMossSpeechOutputRate(setup) {
    if (setup.outputSampleRate == null ||
        setup.outputSampleRate === exports.MOSS_SPEECH_NATIVE_SAMPLE_RATE) {
        return;
    }
    throw new Error(`tts-ggml: the moss-speech engine outputs ${exports.MOSS_SPEECH_NATIVE_SAMPLE_RATE} Hz ` +
        `audio and cannot resample (outputSampleRate=${setup.outputSampleRate})`);
}
/**
 * Validate the MOSS-Speech call and fold the new user turn (spoken `audio`
 * or text `input`) and `systemPrompt` into the native `messages` list.
 */
function resolveSpeechJobFields(source, where) {
    const fields = source ?? {};
    assertSpeechCall(fields, where);
    return {
        messages: speechMessages(fields),
        ...speechReplyVoice(fields),
        ...speechControls(fields),
    };
}
function buildMossSpeechParams(setup) {
    assertMossSpeechOutputRate(setup);
    const parameters = {
        engineType: engineIds_1.ENGINE_MOSS_SPEECH,
        mossSpeechModelPath: setup.paths.mossSpeechModelPath || "",
        mossSpeechCodecPath: setup.paths.mossSpeechCodecPath || "",
    };
    (0, nativeParams_1.assignBackendParams)(setup, parameters);
    return parameters;
}
