"use strict";
const infer_base_1 = require("@qvac/infer-base");
const RUN_BUSY_ERROR_MESSAGE = "Cannot set new job: a job is already set or being processed";
/// Stable, machine-readable identity for the busy refusal. `rejectWhenBusy`
/// exists so callers can handle this condition, and the docs name it
/// `RUN_BUSY`, so it must be branchable without matching the message text
/// (which is prose and may be reworded).
const RUN_BUSY_ERROR_CODE = "RUN_BUSY";
/// Every busy refusal is built here so the message and code cannot drift apart
/// across the admission sites in this file and index.js.
function runBusyError() {
    const err = new Error(RUN_BUSY_ERROR_MESSAGE);
    err.code = RUN_BUSY_ERROR_CODE;
    return err;
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
class BatchHandler {
    static RUN_BUSY_ERROR_MESSAGE = RUN_BUSY_ERROR_MESSAGE;
    static RUN_BUSY_ERROR_CODE = RUN_BUSY_ERROR_CODE;
    static runBusyError = runBusyError;
    _parsePrompt;
    _cancelHandler;
    _runJob;
    /// native jobId -> { ids, response, pendingResult }
    _groups;
    /// per-prompt string id -> native jobId, for routing streaming chunks
    _chunkRoutes;
    constructor({ parsePrompt, cancelHandler, runJob }) {
        this._parsePrompt = parsePrompt;
        this._cancelHandler = cancelHandler;
        this._runJob = runJob;
        this._groups = new Map();
        this._chunkRoutes = new Map();
    }
    /**
     * Classify a `run()` argument. Batch inputs are arrays of either raw
     * `Message[]` prompts or `{ id?, prompt, runOptions? }` wrappers; the
     * single-prompt path keeps the legacy `Message[]` shape.
     */
    static isBatchInput(prompt) {
        if (!Array.isArray(prompt) || prompt.length === 0)
            return false;
        const first = prompt[0];
        return (Array.isArray(first) ||
            (!!first &&
                typeof first === "object" &&
                !Array.isArray(first) &&
                Array.isArray(first.prompt)));
    }
    /** Whether a batch item is a `{ id?, prompt, runOptions? }` wrapper. */
    static _isWrapped(item) {
        return (!!item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            Array.isArray(item.prompt));
    }
    /**
     * Admission policy for a whole batch, derived from per-item `runOptions`.
     * The group is admitted as one native job, so items that set
     * `rejectWhenBusy` must agree; conflicting values are a caller error.
     * Returns the agreed value, or `undefined` when no item sets it (caller
     * falls back to the instance default).
     */
    static groupRejectWhenBusy(batchInput) {
        let policy;
        for (const item of batchInput) {
            const value = BatchHandler._isWrapped(item) ? item.runOptions?.rejectWhenBusy : undefined;
            if (value === undefined)
                continue;
            // Validated before the conflict comparison so a non-boolean can never
            // become the group policy (nor mask a genuine conflict).
            if (typeof value !== "boolean") {
                throw new TypeError("rejectWhenBusy must be a boolean when provided");
            }
            if (policy !== undefined && policy !== value) {
                throw new TypeError("Conflicting rejectWhenBusy across batch items: the batch is admitted as one job");
            }
            policy = value;
        }
        return policy;
    }
    get isActive() {
        return this._groups.size > 0;
    }
    /** Whether a tagged event belongs to one of the in-flight batch groups. */
    owns(jobId) {
        return typeof jobId === "number" && this._groups.has(jobId);
    }
    /**
     * Ship a batch input to the native addon. Returns the `QvacResponse`
     * carrying `response.ids` so consumers can correlate streaming chunks.
     * Caller guards against busy state before invoking; this method only
     * registers group state once admission succeeds.
     */
    async run(batchInput) {
        const items = this._unwrapItems(batchInput);
        // Caller-supplied ids must not collide with another in-flight group, or
        // its streaming chunks would be routed to the wrong response. Auto-minted
        // ids are globally unique natively, so only explicit ids can clash.
        for (const item of items) {
            if (item.id !== undefined && this._chunkRoutes.has(item.id)) {
                throw new Error(`Batch prompt id already in flight: ${item.id}`);
            }
        }
        // The group's native job id, learned at admission. Single-threaded JS
        // guarantees it is set before any consumer can call cancel() on the
        // returned response, so the handler never fires with null.
        let jobId = null;
        const response = new infer_base_1.QvacResponse({
            cancelHandler: () => this._cancelHandler(jobId),
        });
        let result;
        try {
            result = await this._runJob(items);
        }
        catch (err) {
            response.failed(err);
            throw err;
        }
        if (!result.accepted) {
            const err = runBusyError();
            response.failed(err);
            throw err;
        }
        jobId = result.id;
        response.ids = result.ids;
        this._groups.set(result.id, { ids: result.ids, response, pendingResult: null });
        for (const id of result.ids)
            this._chunkRoutes.set(id, result.id);
        return response;
    }
    /** Route a streaming `BatchOutput` chunk to its group's response. */
    onOutput(data) {
        const jobId = this._chunkRoutes.get(data.id);
        const group = jobId === undefined ? null : this._groups.get(jobId);
        group?.response.updateOutput({ id: data.id, chunk: data.output });
    }
    /** Stash a group's final ordered output array until its JobEnded lands. */
    onResult(jobId, data) {
        const group = this._groups.get(jobId);
        if (group)
            group.pendingResult = data;
    }
    /**
     * Terminal event for a group: build the `[ { id, output } ]` array the
     * consumer-facing `await()` resolves with, attach the group's stats, and
     * settle the response.
     */
    onJobEnded(jobId, stats) {
        const group = this._groups.get(jobId);
        if (!group)
            return;
        const outputs = Array.isArray(group.pendingResult) ? group.pendingResult : [];
        const finalResult = group.ids.map((id, index) => ({
            id,
            output: outputs[index] || "",
        }));
        try {
            if (stats !== null)
                group.response.updateStats(stats);
        }
        finally {
            this._drop(jobId, group);
            group.response.ended(finalResult);
        }
    }
    /** Fail one group; peers keep running. */
    onError(jobId, error) {
        const group = this._groups.get(jobId);
        if (!group)
            return;
        this._drop(jobId, group);
        group.response.failed(error);
    }
    /**
     * Settle every in-flight group with @p error and drop all state; called on
     * unload so awaiting batch callers never hang.
     */
    failAll(error) {
        const groups = [...this._groups.values()];
        this.clear();
        let firstError = null;
        for (const group of groups) {
            try {
                group.response.failed(error);
            }
            catch (err) {
                if (firstError === null)
                    firstError = err;
            }
        }
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- rethrows the caught value unchanged.
        if (firstError !== null)
            throw firstError;
    }
    /** Drop every group; called on unload/teardown. */
    clear() {
        this._groups.clear();
        this._chunkRoutes.clear();
    }
    _drop(jobId, group) {
        this._groups.delete(jobId);
        for (const id of group.ids)
            this._chunkRoutes.delete(id);
    }
    _unwrapItems(batchInput) {
        return batchInput.map((item) => {
            const isWrapped = BatchHandler._isWrapped(item);
            const prompt = isWrapped ? item.prompt : item;
            const itemRunOptions = isWrapped && item.runOptions !== undefined ? item.runOptions : {};
            const unwrapped = { messages: this._parsePrompt(prompt, itemRunOptions) };
            if (isWrapped && item.id !== undefined)
                unwrapped.id = item.id;
            return unwrapped;
        });
    }
}
// Runtime-redundant: ESM named imports need the top-level `module.exports.X =` form.
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- `module.exports` is untyped CommonJS surface. */
module.exports.RUN_BUSY_ERROR_MESSAGE = RUN_BUSY_ERROR_MESSAGE;
module.exports.RUN_BUSY_ERROR_CODE = RUN_BUSY_ERROR_CODE;
module.exports.runBusyError = runBusyError;
module.exports = BatchHandler;
/* eslint-enable @typescript-eslint/no-unsafe-member-access */
