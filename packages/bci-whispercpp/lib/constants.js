"use strict";
/**
 * Shared binary-layout and event constants for the BCI wrapper.
 *
 * The stream header is a little-endian `[T (u32), C (u32)]` prefix followed by
 * float32 body samples; the offsets and sizes below describe that layout so
 * the stream helpers and driver never hard-code magic numbers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ADDON_EVENT = exports.STREAM_HEADER_BYTES = exports.CHANNELS_FIELD_OFFSET = exports.TIMESTEPS_FIELD_OFFSET = exports.FLOAT32_BYTES = exports.UINT32_BYTES = void 0;
exports.UINT32_BYTES = 4;
exports.FLOAT32_BYTES = 4;
exports.TIMESTEPS_FIELD_OFFSET = 0;
exports.CHANNELS_FIELD_OFFSET = exports.UINT32_BYTES;
exports.STREAM_HEADER_BYTES = 2 * exports.UINT32_BYTES;
/** Canonical native addon event names emitted through the output callback. */
exports.ADDON_EVENT = Object.freeze({
    OUTPUT: "Output",
    JOB_ENDED: "JobEnded",
    ERROR: "Error",
});
