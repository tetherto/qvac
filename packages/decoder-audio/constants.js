"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUPPORTED_AUDIO_FORMATS = exports.FORMATS_NEEDING_DECODE = void 0;
/**
 * Audio formats that require decoding before processing
 */
exports.FORMATS_NEEDING_DECODE = [
    ".mp3",
    ".m4a",
    ".ogg",
    ".flac",
    ".aac",
    ".wav",
];
/**
 * All supported audio formats (including raw)
 */
exports.SUPPORTED_AUDIO_FORMATS = [
    ".mp3",
    ".m4a",
    ".ogg",
    ".wav",
    ".flac",
    ".aac",
    ".raw",
];
