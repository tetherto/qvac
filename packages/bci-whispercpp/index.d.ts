import QvacLogger = require("@qvac/logging");
import { QvacResponse } from "@qvac/infer-base";
import { BCIInterface } from "./bci";
import { computeWER } from "./lib/wer";
import { type TranscriptSegment } from "./lib/stream";
export interface BCIConfig {
    /**
     * Session day index used to select day-specific projection matrices in
     * bci-embedder.bin.
     *
     *   - `day_idx >= 0` (default `0`): apply the day projection; values beyond
     *     the available range are clamped at the native layer.
     *   - `day_idx === -1`: mel passthrough -- skip preprocessing and treat
     *     the input buffer as pre-computed 512-bin mel features in
     *     frame-major layout. Intended for parity testing against the Python
     *     reference, not production use.
     */
    day_idx?: number;
}
export interface WhisperConfig {
    language?: string;
    n_threads?: number;
    temperature?: number;
    suppress_nst?: boolean;
    suppress_blank?: boolean;
    duration_ms?: number;
    translate?: boolean;
    no_timestamps?: boolean;
    single_segment?: boolean;
    print_special?: boolean;
    print_progress?: boolean;
    print_realtime?: boolean;
    print_timestamps?: boolean;
    detect_language?: boolean;
    greedy_best_of?: number;
    beam_search_beam_size?: number;
}
export interface BCIWhispercppFiles {
    /** Absolute path to the BCI GGML model file. */
    model: string;
    /**
     * Optional path to the embedder weights file. When omitted the native
     * addon resolves `bci-embedder.bin` from the same directory as `model`.
     */
    embedder?: string;
}
export interface BCIWhispercppArgs {
    files: BCIWhispercppFiles;
    logger?: QvacLogger.LoggerInterface;
    opts?: {
        stats?: boolean;
    };
}
export interface BCIWhispercppConfig {
    whisperConfig?: WhisperConfig;
    bciConfig?: BCIConfig;
    contextParams?: {
        model?: string;
        use_gpu?: boolean;
        flash_attn?: boolean;
        gpu_device?: number;
    };
    miscConfig?: {
        caption_enabled?: boolean;
    };
    /**
     * Override the default prebuilds folder used to locate dynamically-
     * loaded ggml backend `.so` modules on Android. When omitted the
     * native side resolves to `<addon>/prebuilds`. Ignored on non-Android
     * targets. Mirrors `transcription-whispercpp 0.9.0`.
     */
    backendsDir?: string;
}
export interface BCIWhispercppState {
    configLoaded: boolean;
    destroyed: boolean;
}
/**
 * Options for {@link BCIWhispercpp.transcribeStream}.
 */
export interface StreamOpts {
    /** Decode window size in timesteps. Must be > 0 and <= MAX_WINDOW_TIMESTEPS. */
    windowTimesteps?: number;
    /** How far the window advances between decodes. Must be > 0 and < windowTimesteps. */
    hopTimesteps?: number;
    /** Whether each update carries only the newly-discovered tail ('delta') or the full running transcript ('full'). */
    emit?: "delta" | "full";
}
export type { TranscriptSegment };
type NeuralStreamInput = AsyncIterable<unknown> | Iterable<unknown> | Uint8Array | Uint8Array[];
/**
 * BCI neural signal transcription client powered by whisper.cpp.
 *
 * Follows the same architecture as TranscriptionWhispercpp / LlmLlamacpp:
 * standalone class using createJobHandler + exclusiveRunQueue from
 * @qvac/infer-base.
 */
export declare class BCIWhispercpp {
    readonly logger: QvacLogger;
    addon: BCIInterface | null;
    state: BCIWhispercppState;
    opts: {
        stats?: boolean;
    };
    private readonly _files;
    private readonly _config;
    private readonly _withExclusiveRun;
    private _inferenceQueueWaiter;
    private readonly _job;
    private _streamResponse;
    private _streamWindowHandler;
    private _streamWindowReject;
    private _streamDriverPromise;
    private _streamAborted;
    constructor({ files, logger, opts }: BCIWhispercppArgs, config?: BCIWhispercppConfig);
    /**
     * Abort any active stream: reject the in-flight window decode (if any),
     * clear the stream side-channel, and fail the outward-facing response.
     * Idempotent. Does NOT await the driver - callers that need the driver
     * to fully unwind (unload/destroy) should `await this._streamDriverPromise`
     * after calling this.
     */
    private _teardownActiveStream;
    getState(): BCIWhispercppState;
    load(): Promise<void>;
    private _load;
    /**
     * Transcribe a neural signal from a binary file.
     * Convenience wrapper around transcribe().
     */
    transcribeFile(filePath: string): Promise<QvacResponse>;
    /**
     * Transcribe neural signal data (batch mode).
     * Returns a QvacResponse; use response.await() for the final output array,
     * response.onUpdate() for streaming updates, response.stats for runtime stats.
     */
    transcribe(neuralData: Uint8Array): Promise<QvacResponse>;
    /**
     * Incrementally transcribe a neural signal stream using a sliding window
     * over the existing batch `runJob` pipeline. Purely JS-side; no native
     * streaming hooks are used.
     *
     * Input shape (header semantics):
     *   [T (u32 LE), C (u32 LE), body bytes...]
     * In streaming mode the T field is required to be present for format
     * compatibility with batch inputs but is ignored; window sizing comes
     * from `streamOpts.windowTimesteps`. C must be non-zero.
     *
     * Stream input types accepted: async iterable, sync iterable, Uint8Array,
     * or chunk array. Each yielded chunk must be a Uint8Array / ArrayBuffer
     * view / ArrayBuffer / plain byte array.
     *
     * Emission contract: `response.onUpdate(...)` fires per window that
     * produced non-empty text.
     *   - emit:'delta' (default): update carries the trimmed native segments
     *     for the newly-discovered tail, preserving each segment's native
     *     fields (`text`, `t0`, `t1`, ...). Each segment is additionally
     *     annotated with `windowStartTimestep` (the absolute timestep at
     *     which its owning window began) so consumers can map window-local
     *     timestamps back to the stream timeline.
     *   - emit:'full': update carries a single `{ text }` entry with the
     *     full running transcript. Per-segment timestamps are NOT preserved
     *     in this mode because a cumulative segment timeline across windows
     *     cannot be reliably reconstructed from window-local timestamps.
     *
     * `response.await()` resolves once the input stream ends and the final
     * flush window decodes. `response.stats` is not populated for streams.
     */
    transcribeStream(neuralStream: NeuralStreamInput, streamOpts?: StreamOpts): Promise<QvacResponse>;
    private _runStreamDriver;
    private _decodeWindow;
    /**
     * Apply defaults and validate `streamOpts` passed to transcribeStream().
     * Centralised so the public method body stays focused on orchestration,
     * mirroring whispercpp's `_checkParamsExists` pattern. Returns a new
     * opts object; does not mutate the caller's input.
     */
    private _validateStreamOpts;
    private _normalizeNeuralStream;
    /**
     * Serialize inference runs so a second transcribe() waits until the first
     * response settles. Separate from _withExclusiveRun (lifecycle ops) so
     * destroy/unload can still preempt.
     */
    private _enqueueInference;
    private _assertReadyForInference;
    private _isConfigurationError;
    /**
     * Single sink for native addon events. During a stream, events are
     * diverted to the active `_streamWindowHandler` (registered by
     * `_decodeWindow`) instead of the batch `_job`. This side-channel
     * exists because per-window `runJob` calls must resolve into the
     * streaming driver rather than the `_job` state machine, which is
     * reserved for batch `transcribe()` calls and not used while a stream
     * is active. When `_streamWindowHandler` is null the batch path runs.
     */
    private _outputCallback;
    cancel(): Promise<void>;
    unload(): Promise<void>;
    destroy(): Promise<void>;
}
export { computeWER };
export default BCIWhispercpp;
