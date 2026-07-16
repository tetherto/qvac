/**
 * Shared binary-layout and event constants for the BCI wrapper.
 *
 * The stream header is a little-endian `[T (u32), C (u32)]` prefix followed by
 * float32 body samples; the offsets and sizes below describe that layout so
 * the stream helpers and driver never hard-code magic numbers.
 */

export const UINT32_BYTES = 4;
export const FLOAT32_BYTES = 4;
export const TIMESTEPS_FIELD_OFFSET = 0;
export const CHANNELS_FIELD_OFFSET = UINT32_BYTES;
export const STREAM_HEADER_BYTES = 2 * UINT32_BYTES;

/** Canonical native addon event names emitted through the output callback. */
export const ADDON_EVENT = Object.freeze({
  OUTPUT: "Output",
  JOB_ENDED: "JobEnded",
  ERROR: "Error",
});
