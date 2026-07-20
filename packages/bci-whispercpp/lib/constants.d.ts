/**
 * Shared binary-layout and event constants for the BCI wrapper.
 *
 * The stream header is a little-endian `[T (u32), C (u32)]` prefix followed by
 * float32 body samples; the offsets and sizes below describe that layout so
 * the stream helpers and driver never hard-code magic numbers.
 */
export declare const UINT32_BYTES = 4;
export declare const FLOAT32_BYTES = 4;
export declare const TIMESTEPS_FIELD_OFFSET = 0;
export declare const CHANNELS_FIELD_OFFSET = 4;
export declare const STREAM_HEADER_BYTES: number;
/** Canonical native addon event names emitted through the output callback. */
export declare const ADDON_EVENT: Readonly<{
    OUTPUT: "Output";
    JOB_ENDED: "JobEnded";
    ERROR: "Error";
}>;
