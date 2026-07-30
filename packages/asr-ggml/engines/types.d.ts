import type QvacLogger from "@qvac/logging";
import type { JobHandler, QvacResponse } from "@qvac/infer-base";
import type { ASRRunOutput, ASRStreamOutput, AudioInput, BackendInfo } from "../lib/types";
import type { WhisperReloadConfig, WhisperStreamingOptions } from "./whisper/driver";
import type { ParakeetReloadConfig, ParakeetStreamingRunConfig } from "./parakeet/driver";
export type EngineType = "whisper" | "parakeet";
/** Files handed to the client; the engine drivers receive them verbatim. */
export interface ASRGgmlFiles {
    /** Absolute path to the model checkpoint. Required, non-empty. */
    model: string;
    /** Whisper streaming only: absolute path to the Silero VAD model. */
    vadModel?: string;
}
/** Per-call `runStreaming` options, engine-scoped and driver-validated. */
export type ASRStreamingOptions = WhisperStreamingOptions | ParakeetStreamingRunConfig;
/** Engine-scoped `reload()` configuration. */
export type ASRGgmlReloadConfig = WhisperReloadConfig | ParakeetReloadConfig;
export interface DriverContext {
    logger: QvacLogger;
    /** Single JobHandler shared with the orchestrator. */
    job: JobHandler;
    enableStats: boolean;
}
export type NormalizedAudioStream = AsyncIterable<Float32Array> | Iterable<Float32Array>;
export interface StreamingSession {
    response: QvacResponse<ASRStreamOutput>;
    /**
     * Settles when the response settles AND driver teardown has completed.
     * The orchestrator clears its open-session flag on settlement (both
     * paths).
     */
    done: Promise<void>;
}
/**
 * The minimum shape of the native interface a driver owns
 * (`WhisperInterface` / `ParakeetInterface`). Exposed through
 * `ASRGgml.addon` only so the SDK can issue a native hard cancel that does
 * not fail the active job; everything else goes through `ASRGgml`.
 */
export interface AsrNativeInterface {
    cancel(jobId?: number): Promise<void>;
    status(): Promise<string>;
    getBackendInfo?(): BackendInfo | null;
}
/**
 * Internal per-engine driver contract — this interface, in full, is what a
 * third engine has to implement. Drivers own the native-interface object,
 * all engine-specific event mapping, and the entire streaming lifecycle
 * (precondition checks, pump, back-pressure, teardown). The orchestrator owns
 * options parsing, engine resolution, the state machine, the two serialized
 * queues (inference and lifecycle), the open-session flag, and
 * `pause`/`unpause` rejection.
 *
 * Native-config building and native-event mapping are deliberately NOT on
 * the contract: they are per-driver private methods
 * (`_buildConfigurationParams`, `_buildStreamingConfig`, `_outputCallback`)
 * because their inputs and outputs are engine-specific. Nothing outside a
 * driver calls them.
 */
export interface AsrDriver {
    readonly engineType: EngineType;
    /**
     * Whether `reload()` is implemented natively. `ASRGgml.reload()` consults
     * this and rejects with `NOT_SUPPORTED` when it is false, so a driver
     * without native reload does not have to fake one.
     */
    readonly supportsReload: boolean;
    /** The live native interface; `undefined` before `load()`. */
    readonly addon?: AsrNativeInterface;
    /** Throws `QvacErrorAddonASRGgml` on unknown/invalid config keys. */
    validateConfig(): void;
    /** Normalizes any public audio input shape; throws INVALID_AUDIO_INPUT. */
    normalizeAudio(input: AudioInput): NormalizedAudioStream;
    /** Creates the native interface and activates the model. */
    load(): Promise<void>;
    /** Destroys the native instance. */
    unload(): Promise<void>;
    reload(newConfig?: ASRGgmlReloadConfig): Promise<void>;
    cancelActive(jobId?: number): Promise<void>;
    status(): Promise<string>;
    getBackendInfo(): BackendInfo | null;
    /**
     * Batch: starts the job on ctx.job, pumps `audio`, returns the response.
     * All output/end/fail flows through ctx.job from the driver's output
     * callback.
     */
    run(audio: NormalizedAudioStream): Promise<QvacResponse<ASRRunOutput>>;
    /**
     * Duplex streaming. The returned promise resolves once the native session
     * is OPEN (setup complete) — that is the point where the orchestrator
     * releases the exclusive-run slot. The pump keeps running detached;
     * errors fail ctx.job.
     */
    createStreamingSession(audio: NormalizedAudioStream, opts: ASRStreamingOptions): Promise<StreamingSession>;
}
