/** Sentinel `append()` type that submits the buffered audio as one job. */
export declare const END_OF_INPUT = "end of job";
/**
 * Cap on the **caller-supplied** audio bytes a single batch job may buffer
 * ahead of submission: 500 MB, i.e. ~4.55 hours of 16 kHz s16le mono or
 * ~2.27 hours of 16 kHz f32le mono.
 *
 * Both pre-merge packages used this same number, but charged it against the
 * bytes the caller handed in. The whisper driver now converts every input to
 * f32 samples in JS before `append()`, which doubles the byte count of s16le
 * input, so `WhisperInterface` scales the budget by the source→wire expansion
 * factor (see `WhisperInterface.setSourceByteFormat`) instead of comparing
 * wire bytes against this constant directly. Without that scaling the cap
 * would silently halve the accepted duration of s16le audio — the default
 * and by far the most common whisper input.
 */
export declare const MAX_BUFFERED_BYTES: number;
