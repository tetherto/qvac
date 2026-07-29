/** Sentinel `append()` type that submits the buffered audio as one job. */
export const END_OF_INPUT = "end of job";

/**
 * Cap on audio bytes buffered ahead of a batch job submission.
 * 500 MB — ~2.27 hours of 16 kHz f32le mono audio.
 */
export const MAX_BUFFERED_BYTES = 500 * 1024 * 1024;
