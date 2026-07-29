"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_BUFFERED_BYTES = exports.END_OF_INPUT = void 0;
/** Sentinel `append()` type that submits the buffered audio as one job. */
exports.END_OF_INPUT = "end of job";
/**
 * Cap on audio bytes buffered ahead of a batch job submission.
 * 500 MB — ~2.27 hours of 16 kHz f32le mono audio.
 */
exports.MAX_BUFFERED_BYTES = 500 * 1024 * 1024;
