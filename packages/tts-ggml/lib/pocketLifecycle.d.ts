/**
 * The Pocket engine's execution rules. Pocket runs one native job at a time
 * and reports its end through a terminal callback (stats or error), so each
 * job sits behind a completion barrier that is drained before the next
 * request, and lifecycle operations (load, unload, destroy, reload) refuse to
 * overlap.
 */
import type { QvacResponse } from "@qvac/infer-base";
import type QvacLoggerType from "@qvac/logging";
import type { TTSConfigurationParams, TTSInterface, TTSJobData } from "../tts";
import type { EngineSetup } from "./engineSetup";
import type { InferenceState } from "./types";
/** What the Pocket rules need from the wrapper that owns the native instance. */
export interface PocketHost {
    readonly setup: EngineSetup;
    readonly state: InferenceState;
    logger(): QvacLoggerType;
    /** The live native instance, or null. */
    optionalAddon(): TTSInterface | null;
    /** Makes `addon` the instance the wrapper reports and routes events from. */
    setAddon(addon: TTSInterface): void;
    /** A new native instance wired to the wrapper's output callback. */
    createAddon(params: TTSConfigurationParams): TTSInterface;
    unloadModel(): Promise<void>;
    /** The response a job is running for, or null when idle. */
    activeJob(): QvacResponse | null;
    /** Fails the active sentence stream, if any, with `reason`. */
    failStream(reason: string): void;
}
interface PendingJob {
    promise: Promise<void>;
    resolve: () => void;
}
export declare class PocketLifecycle {
    private readonly host;
    /** The native job awaiting its terminal callback, or null. */
    jobPending: PendingJob | null;
    private cancelPromise;
    private inProgress;
    constructor(host: PocketHost);
    /** A cancel in flight finishes, terminal callback included, before anything else starts. */
    waitCancel(): Promise<void>;
    /** One lifecycle operation at a time; requests are refused while one runs. */
    checkReload(): void;
    /** A synthesis request needs a loaded instance and no job in flight. */
    checkRequest(): void;
    withLifecycle(action: () => Promise<void>): Promise<void>;
    /** Runs the job behind a completion barrier that its terminal callback releases. */
    runJob(addon: TTSInterface, input: TTSJobData): Promise<void>;
    /** A terminal native callback (error or stats) releases the completion barrier. */
    onNativeEvent(data: unknown, error: unknown): void;
    /**
     * Fails `response` with the caller's reason and stops native work. The
     * completion barrier stays until the terminal callback arrives.
     */
    attachAbort(response: QvacResponse, signal: AbortSignal): void;
    /** Stops native work and waits for the job in flight to report its end. */
    cancel(): Promise<void>;
    /**
     * Replaces the native instance with one built from the merged options.
     * Native work is drained and the old model released before the replacement
     * is allocated; a failed activation leaves the instance unloaded with its
     * last good configuration.
     */
    reload(newConfig: Record<string, unknown>): Promise<void>;
}
export {};
