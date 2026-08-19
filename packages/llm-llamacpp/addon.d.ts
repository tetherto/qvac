import type { FinetuneOptions, GenerationParams } from "./index";
declare const STOP_REASONS: readonly ["none", "eos", "antiprompt", "predictionLimit", "sequenceLimit", "contextOverflow"];
export type StopReason = (typeof STOP_REASONS)[number];
export interface AddonMessage {
    type: "text";
    input: string;
    prefill?: boolean;
    /**
     * Per-call sampling overrides forwarded by `LlmLlamacpp.run()` from
     * `RunOptions.generationParams`. Carried on the `text` message and consumed
     * by the native binding so each `runJob` can use a different temp / top_p /
     * seed / etc. without re-loading the model.
     */
    generationParams?: GenerationParams;
    cacheKey?: string;
    saveCacheToDisk?: boolean;
}
export interface AddonMediaMessage {
    type: "media";
    content: Uint8Array;
}
export type AddonRunJobMessage = AddonMessage | AddonMediaMessage;
/**
 * Discriminated admission result: the native binding only sets `id` when the
 * scheduler minted one, so a job id exists exactly when the job was accepted.
 */
export type AdmissionResult = {
    accepted: true;
    /** Native-assigned job id used to route this request's streamed output. */
    id: number;
} | {
    accepted: false;
    id?: never;
};
export type AddonRunJobResult = AdmissionResult;
export interface AddonBatchRunItem {
    /** Optional caller-supplied id; the native binding auto-assigns one when omitted. */
    id?: string;
    messages: AddonRunJobMessage[];
}
/**
 * Batch admission result. The per-sequence `ids` are reported on both
 * branches (they are assigned while parsing the batch input); the native
 * group id used to route the batch's terminal events exists only when the
 * batch was accepted.
 */
export type AddonBatchRunResult = {
    accepted: true;
    /** Native group id used by the batch handler to route this group's terminal events. */
    id: number;
    ids: string[];
} | {
    accepted: false;
    id?: never;
    ids: string[];
};
export interface LoadWeightsData {
    filename: string;
    chunk: Uint8Array | null;
    completed: boolean;
}
export interface AddonConfigurationParams {
    path: string;
    projectionPath: string;
    config: Record<string, unknown>;
}
export type AddonOutputCallback = (addon: unknown, event: unknown, data: unknown, error: unknown, jobId: unknown) => void;
export interface LlamaBinding {
    createInstance(owner: LlamaInterface, configurationParams: AddonConfigurationParams, outputCallback: AddonOutputCallback, reserved: null): object;
    loadWeights(handle: unknown, data: LoadWeightsData): Promise<void> | void;
    activate(handle: unknown): Promise<void> | void;
    activeJobs(handle: unknown): number;
    activeSlots(handle: unknown): number;
    cancel(handle: unknown, savePauseCheckpoint: number): Promise<void> | void;
    cancelJob(handle: unknown, id: number): Promise<void> | void;
    finetune?(handle: unknown, params: FinetuneOptions): Promise<number | false> | number | false;
    runJob(handle: unknown, data: AddonRunJobMessage[]): Promise<AddonRunJobResult>;
    runJob(handle: unknown, data: AddonBatchRunItem[]): Promise<AddonBatchRunResult>;
    destroyInstance(handle: unknown): void;
}
export type MappedAddonEvent = {
    type: string;
    data: unknown;
    error: unknown;
};
/**
 * Normalize a raw native event into `Output` / `Error` / `JobEnded` /
 * `FinetuneProgress`, or `null` to drop it.
 */
export declare function mapAddonEvent(rawEvent: unknown, rawData: unknown, rawError: unknown): MappedAddonEvent | null;
/**
 * An interface between Bare addon in C++ and JS runtime.
 */
export declare class LlamaInterface {
    private readonly _binding;
    private _handle;
    constructor(binding: unknown, configurationParams: AddonConfigurationParams, outputCb: AddonOutputCallback);
    loadWeights(weightsData: LoadWeightsData): Promise<void>;
    /**
     * Moves addon to the LISTENING state after all the initialization is done
     */
    activate(): Promise<void>;
    /**
     * Active jobs (in-flight + queued) per the native scheduler — the
     * authoritative admission count.
     */
    activeJobs(): number;
    /**
     * Requests occupying or waiting for a continuous-batching slot (active +
     * pending). Capacity is consumed in slots, not jobs: one batch job of N
     * prompts takes up to N of them, so `activeJobs()` alone under-reports a
     * full pool. 0 when no batch scheduler is active (`parallel: 1`), where the
     * job count is the right measure — admission therefore compares the max of
     * the two against `parallel`.
     */
    activeSlots(): number;
    /**
     * Cancel every inference job live at the moment of this call (or pause a
     * running finetune). Snapshot-based: the native binding captures the live
     * job ids synchronously before deferring the cancellation, so a job started
     * after this call is never touched.
     */
    cancel(savePauseCheckpoint?: number): Promise<void>;
    /**
     * Cancel a single job by its native-assigned id, leaving other concurrent
     * jobs running. Routes to MultiJobScheduler::cancel(id) -> cancelById(id).
     */
    cancelJob(id: number): Promise<void>;
    /**
     * Run finetuning when native binding provides support.
     */
    finetune(finetuningParams: FinetuneOptions): Promise<number | false>;
    /**
     * Run one inference job with an array of message objects, or a batch of
     * jobs with an array of `{id?, messages}` items. The native binding mints
     * the job id (single) / group id (batch) and returns it so concurrent jobs
     * can be routed; a batch result also carries the per-item `ids` assigned
     * to each sequence.
     */
    runJob(data: AddonRunJobMessage[]): Promise<AddonRunJobResult>;
    runJob(data: AddonBatchRunItem[]): Promise<AddonBatchRunResult>;
    /**
     * Unload the model and clear resources (including memory).
     */
    unload(): Promise<void>;
}
export {};
