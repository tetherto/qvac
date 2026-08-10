import { QvacResponse } from "@qvac/infer-base";
import type { AddonBatchRunItem, AddonBatchRunResult, AddonRunJobMessage } from "./addon";
import type { BatchOutputChunk, BatchPrompt, Message, RunOptions } from "./index";
declare function runBusyError(): Error;
type BatchInput = (Message[] | BatchPrompt)[];
type BatchGroupResponse = QvacResponse<BatchOutputChunk> & {
    ids: string[];
};
interface BatchHandlerDeps {
    parsePrompt: (prompt: Message[], runOptions: RunOptions) => AddonRunJobMessage[];
    cancelHandler: (jobId: number | null) => Promise<void> | void;
    runJob: (items: AddonBatchRunItem[]) => Promise<AddonBatchRunResult>;
}
/**
 * Encapsulates the JS-side continuous-batching flow that sits on top of
 * `LlmLlamacpp`: input classification, prompt unwrapping, native
 * `runJob` admission, and reassembly of streaming `BatchOutput` chunks
 * plus the final ordered `BatchResult` array delivered with the addon's
 * terminal `JobEnded` event.
 *
 * Several batch groups may be in flight at once: each `run()` is admitted
 * as one tagged native job, and the group's terminal events (result,
 * jobEnded stats, error) are routed here by that native job id. Streaming
 * chunks are untagged but carry their per-prompt string id, routed via
 * `_chunkRoutes`.
 */
declare class BatchHandler {
    static readonly RUN_BUSY_ERROR_MESSAGE = "Cannot set new job: a job is already set or being processed";
    static readonly RUN_BUSY_ERROR_CODE = "RUN_BUSY";
    static readonly runBusyError: typeof runBusyError;
    private readonly _parsePrompt;
    private readonly _cancelHandler;
    private readonly _runJob;
    private readonly _groups;
    private readonly _chunkRoutes;
    constructor({ parsePrompt, cancelHandler, runJob }: BatchHandlerDeps);
    /**
     * Classify a `run()` argument. Batch inputs are arrays of either raw
     * `Message[]` prompts or `{ id?, prompt, runOptions? }` wrappers; the
     * single-prompt path keeps the legacy `Message[]` shape.
     */
    static isBatchInput(prompt: unknown): prompt is BatchInput;
    /** Whether a batch item is a `{ id?, prompt, runOptions? }` wrapper. */
    private static _isWrapped;
    /**
     * Admission policy for a whole batch, derived from per-item `runOptions`.
     * The group is admitted as one native job, so items that set
     * `rejectWhenBusy` must agree; conflicting values are a caller error.
     * Returns the agreed value, or `undefined` when no item sets it (caller
     * falls back to the instance default).
     */
    static groupRejectWhenBusy(batchInput: BatchInput): boolean | undefined;
    get isActive(): boolean;
    /** Whether a tagged event belongs to one of the in-flight batch groups. */
    owns(jobId: unknown): jobId is number;
    /**
     * Ship a batch input to the native addon. Returns the `QvacResponse`
     * carrying `response.ids` so consumers can correlate streaming chunks.
     * Caller guards against busy state before invoking; this method only
     * registers group state once admission succeeds.
     */
    run(batchInput: BatchInput): Promise<BatchGroupResponse>;
    /** Route a streaming `BatchOutput` chunk to its group's response. */
    onOutput(data: {
        id: string;
        output: string;
    }): void;
    /** Stash a group's final ordered output array until its JobEnded lands. */
    onResult(jobId: number, data: string[]): void;
    /**
     * Terminal event for a group: build the `[ { id, output } ]` array the
     * consumer-facing `await()` resolves with, attach the group's stats, and
     * settle the response.
     */
    onJobEnded(jobId: number, stats: unknown): void;
    /** Fail one group; peers keep running. */
    onError(jobId: number, error: Error): void;
    /**
     * Settle every in-flight group with @p error and drop all state; called on
     * unload so awaiting batch callers never hang.
     */
    failAll(error: Error): void;
    /** Drop every group; called on unload/teardown. */
    clear(): void;
    private _drop;
    private _unwrapItems;
}
export = BatchHandler;
