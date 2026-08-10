"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
const fs = require("bare-fs");
const path = require("bare-path");
const QvacLogger = require("@qvac/logging");
const BatchHandler = require("./batchHandler");
/* eslint-enable @typescript-eslint/no-require-imports */
const infer_base_1 = require("@qvac/infer-base");
const addon_1 = require("./addon");
const { runBusyError } = BatchHandler;
function normalizeRunOptions(runOptions) {
    if (runOptions === undefined) {
        return {
            prefill: false,
            generationParams: undefined,
            cacheKey: undefined,
            saveCacheToDisk: false,
            rejectWhenBusy: undefined,
        };
    }
    if (!runOptions || typeof runOptions !== "object" || Array.isArray(runOptions)) {
        throw new TypeError("Run options must be an object when provided");
    }
    const options = runOptions;
    if (options.prefill !== undefined && typeof options.prefill !== "boolean") {
        throw new TypeError("prefill must be a boolean when provided");
    }
    if (options.generationParams !== undefined &&
        (typeof options.generationParams !== "object" ||
            options.generationParams === null ||
            Array.isArray(options.generationParams))) {
        throw new TypeError("generationParams must be a plain object when provided");
    }
    if (options.cacheKey !== undefined && typeof options.cacheKey !== "string") {
        throw new TypeError("cacheKey must be a string when provided");
    }
    if (options.saveCacheToDisk !== undefined && typeof options.saveCacheToDisk !== "boolean") {
        throw new TypeError("saveCacheToDisk must be a boolean when provided");
    }
    if (options.rejectWhenBusy !== undefined && typeof options.rejectWhenBusy !== "boolean") {
        throw new TypeError("rejectWhenBusy must be a boolean when provided");
    }
    return {
        prefill: options.prefill === true,
        generationParams: normalizeGenerationParams(options.generationParams),
        cacheKey: options.cacheKey,
        saveCacheToDisk: options.saveCacheToDisk === true,
        // Left undefined when unset so admission falls back to the instance default.
        rejectWhenBusy: options.rejectWhenBusy,
    };
}
function promptToAddonMessages(prompt, runOptions) {
    if (!Array.isArray(prompt)) {
        throw new TypeError("Prompt input must be Message[]");
    }
    const { prefill, generationParams, cacheKey, saveCacheToDisk } = normalizeRunOptions(runOptions);
    const textMessages = [];
    const mediaItems = [];
    for (const message of prompt) {
        const media = message;
        if (media.role === "user" && media.type === "media" && media.content instanceof Uint8Array) {
            mediaItems.push(media.content);
            textMessages.push({ ...media, content: "" });
        }
        else {
            textMessages.push(message);
        }
    }
    const promptMessages = [];
    for (const mediaData of mediaItems) {
        promptMessages.push({ type: "media", content: mediaData });
    }
    promptMessages.push({
        type: "text",
        input: JSON.stringify(textMessages),
        prefill,
        generationParams,
        cacheKey,
        saveCacheToDisk,
    });
    return promptMessages;
}
// Normalizes the per-request `generationParams.json_schema` field. The
// addon binding expects a string; callers commonly pass a plain object
// (a JSON Schema literal) for ergonomics, so we stringify it here. Also
// validates the mutual exclusion with `grammar`, since enforcing it at
// the JS boundary gives a clearer error than letting the C++ throw.
function normalizeGenerationParams(generationParams) {
    if (generationParams === undefined)
        return undefined;
    if (generationParams.remove_thinking_from_context !== undefined &&
        typeof generationParams.remove_thinking_from_context !== "boolean") {
        throw new TypeError("generationParams.remove_thinking_from_context must be a boolean when provided");
    }
    const hasGrammar = typeof generationParams.grammar === "string" && generationParams.grammar.length > 0;
    const hasJsonSchema = generationParams.json_schema !== undefined &&
        generationParams.json_schema !== null &&
        !(typeof generationParams.json_schema === "string" && generationParams.json_schema.length === 0);
    if (hasGrammar && hasJsonSchema) {
        throw new TypeError("generationParams.grammar and generationParams.json_schema are mutually exclusive");
    }
    if (!hasJsonSchema)
        return generationParams;
    let jsonSchemaString;
    if (typeof generationParams.json_schema === "string") {
        jsonSchemaString = generationParams.json_schema;
    }
    else if (typeof generationParams.json_schema === "object" &&
        !Array.isArray(generationParams.json_schema)) {
        try {
            jsonSchemaString = JSON.stringify(generationParams.json_schema);
        }
        catch (err) {
            throw new TypeError("generationParams.json_schema is not JSON-serializable: " + err.message);
        }
    }
    else {
        throw new TypeError("generationParams.json_schema must be a JSON Schema object or a JSON Schema string");
    }
    return { ...generationParams, json_schema: jsonSchemaString };
}
const VALIDATION_TYPES = ["none", "split", "dataset"];
const DEFAULT_VALIDATION_FRACTION = 0.05;
/// Upper bound for `parallel`, mirroring K_MAX_PARALLEL_WORKERS in
/// addon/src/addon/AddonJs.hpp — the engine's own n_seq_max ceiling
/// (LLAMA_MAX_SEQ in qvac-fabric). Keep the two in sync.
const MAX_PARALLEL = 256;
function normalizeFinetuneParams(opts) {
    const validation = opts.validation;
    if (Object.prototype.hasOwnProperty.call(opts, "evalDatasetPath")) {
        throw new Error("Top-level evalDatasetPath is no longer supported. Use validation.path with validation.type set to 'dataset'.");
    }
    if (validation === null ||
        validation === undefined ||
        typeof validation !== "object" ||
        !("type" in validation)) {
        throw new Error("Finetuning options must include validation: { type: 'none' | 'split' | 'dataset'[, fraction?: number][, path?: string] }. " +
            "Example: validation: { type: 'split', fraction: 0.05 }, validation: { type: 'dataset', path: './eval.jsonl' }, or validation: { type: 'none' }.");
    }
    const out = { ...opts };
    const type = validation.type;
    if (!VALIDATION_TYPES.includes(type)) {
        throw new Error(`validation.type must be one of ${VALIDATION_TYPES.join(", ")}; got: ${type}`);
    }
    if (type === "none") {
        out.validationSplit = 0;
        out.useEvalDatasetForValidation = false;
        delete out.evalDatasetPath;
    }
    else if (type === "split") {
        const fraction = validation.fraction ?? DEFAULT_VALIDATION_FRACTION;
        out.validationSplit = Math.max(0, Math.min(1, Number(fraction)));
        out.useEvalDatasetForValidation = false;
        delete out.evalDatasetPath;
    }
    else {
        const evalPath = validation.path;
        if (!evalPath || typeof evalPath !== "string" || evalPath.trim() === "") {
            throw new Error("validation.type is 'dataset' but no path is provided. Set validation.path to the eval dataset file path (e.g. validation: { type: 'dataset', path: './eval.jsonl' }).");
        }
        if (evalPath === opts.trainDatasetDir) {
            throw new Error("validation.type is 'dataset' but validation.path is the same as trainDatasetDir. Provide a separate eval dataset path.");
        }
        out.evalDatasetPath = evalPath;
        out.validationSplit = 0;
        out.useEvalDatasetForValidation = true;
    }
    delete out.validation;
    return out;
}
/**
 * Returns the first shard (matching `-NNNNN-of-MMMMM.gguf`) or the sole
 * entry for single-file models. Matches the C++ shard-expansion contract
 * in `GGUFShards::expandGGUFIntoShards`.
 */
function pickPrimaryGgufPath(files) {
    const SHARD_REGEX = /-\d+-of-\d+\.gguf$/;
    return files.find((p) => SHARD_REGEX.test(p)) || files[0];
}
// Replace media Uint8Array contents with a small summary so the logger never
// asks V8 to JSON.stringify multi-MB binary blobs.
function sanitizePromptForLog(prompt) {
    if (!Array.isArray(prompt))
        return prompt;
    return prompt.map((msg) => {
        const media = msg;
        if (media && media.type === "media" && media.content instanceof Uint8Array) {
            return { ...media, content: `[Uint8Array byteLength=${media.content.byteLength}]` };
        }
        return msg;
    });
}
/** LLM client wrapping the native LlamaInterface for inference, finetuning, and pause/resume. */
const LlmLlamacpp = class LlmLlamacpp {
    static pickPrimaryGgufPath = pickPrimaryGgufPath;
    // Attached for tests; untyped because `typeof QvacResponse` is not nameable by consumers.
    static QvacResponse = infer_base_1.QvacResponse;
    addon;
    opts;
    logger;
    state;
    _files;
    _projectionModelPath;
    _config;
    _finetuneJob;
    _run;
    _maxConcurrency;
    _rejectWhenBusy;
    _jobSinks;
    _batchHandler;
    _checkpointSaveDir;
    constructor({ files, config, logger = null, opts = {} }) {
        if (!files || !Array.isArray(files.model) || files.model.length === 0) {
            throw new TypeError("files.model must be a non-empty array of absolute paths");
        }
        for (const [i, entry] of files.model.entries()) {
            if (typeof entry !== "string" || entry.length === 0) {
                throw new TypeError(`files.model[${i}] must be an absolute path string`);
            }
            if (!path.isAbsolute(entry)) {
                throw new TypeError(`files.model[${i}] must be an absolute path (got: ${entry})`);
            }
        }
        if (files.projectionModel !== undefined) {
            if (typeof files.projectionModel !== "string" || files.projectionModel.length === 0) {
                throw new TypeError("files.projectionModel must be an absolute path string");
            }
            if (!path.isAbsolute(files.projectionModel)) {
                throw new TypeError(`files.projectionModel must be an absolute path (got: ${files.projectionModel})`);
            }
        }
        this._files = files.model;
        this._projectionModelPath = files.projectionModel || "";
        this._config = config;
        this.logger = new QvacLogger(logger);
        this.opts = opts;
        // Finetune-only response holder. Tagged finetune events reach it through
        // the _finetuneSink adapter registered in _jobSinks under the exclusive
        // job's native id; inference never touches this handler.
        // Lazy deref + optional chain: safe before `_load()` and after `unload()`.
        this._finetuneJob = (0, infer_base_1.createJobHandler)({ cancel: () => this.addon?.cancel() });
        this._run = (0, infer_base_1.exclusiveRunQueue)();
        this.addon = null;
        this._checkpointSaveDir = null;
        // Concurrency is the caller's configured `parallel` (n_seq_max); values
        // >= 2 enable multi-job routing. Fixed for the model's lifetime, so it is
        // derived once here rather than queried from the loaded model. The 1..256
        // range mirrors the native K_MAX_PARALLEL_WORKERS contract in createInstance
        // (addon/src/addon/AddonJs.hpp) — keep the two in sync. 256 is the
        // engine's own n_seq_max ceiling (LLAMA_MAX_SEQ in qvac-fabric).
        if (config?.parallel !== undefined) {
            const parallel = Number(config.parallel);
            if (!/^[0-9]+$/.test(String(config.parallel)) ||
                !Number.isSafeInteger(parallel) ||
                parallel < 1 ||
                parallel > MAX_PARALLEL) {
                throw new TypeError(`parallel must be an integer between 1 and ${MAX_PARALLEL}`);
            }
            this._maxConcurrency = parallel;
        }
        else {
            this._maxConcurrency = 1;
        }
        /// Admission policy when at capacity: true throws RUN_BUSY, false lets the
        /// native multi-job scheduler admit/queue it. Overridable per call via
        /// `runOptions.rejectWhenBusy` (batch runs derive one group policy from
        /// their items' runOptions). Defaults to throwing on the sequential
        /// path (`parallel: 1`, backward compat) and to queueing when the
        /// multi-job scheduler is active (`parallel >= 2`).
        if (opts?.rejectWhenBusy !== undefined && typeof opts.rejectWhenBusy !== "boolean") {
            throw new TypeError("opts.rejectWhenBusy must be a boolean when provided");
        }
        this._rejectWhenBusy = opts?.rejectWhenBusy ?? this._maxConcurrency === 1;
        /// Maps the native-assigned jobId → response for active concurrent requests.
        this._jobSinks = new Map();
        this._batchHandler = new BatchHandler({
            parsePrompt: promptToAddonMessages,
            cancelHandler: (jobId) => this.addon?.cancelJob(jobId),
            runJob: (items) => this.addon.runJob(items),
        });
        this.state = { configLoaded: false };
    }
    load() {
        return this._run(async () => {
            if (this.state.configLoaded)
                return;
            await this._load();
            this.state.configLoaded = true;
        });
    }
    async _load() {
        this.logger.info("Starting model load");
        const primaryGgufPath = pickPrimaryGgufPath(this._files);
        const configurationParams = {
            path: primaryGgufPath,
            projectionPath: this._projectionModelPath,
            config: { ...this._config },
        };
        this.logger.info("Creating addon with configuration:", configurationParams);
        try {
            this.addon = this._createAddon(configurationParams);
            if (this._files.length > 1) {
                await this._streamShards();
            }
            this.logger.info("Activating addon");
            await this.addon.activate();
        }
        catch (loadError) {
            this.logger.error("Error during model load:", loadError);
            // Best-effort cleanup of the partially-initialized addon so a subsequent
            // load() does not leak a zombie native instance.
            try {
                await this.addon?.unload?.();
            }
            catch { }
            this.addon = null;
            throw loadError;
        }
        this.logger.info("Model load completed successfully");
    }
    async _streamShards() {
        for (const filePath of this._files) {
            const filename = path.basename(filePath);
            const stream = fs.createReadStream(filePath);
            for await (const chunk of stream) {
                await this.addon.loadWeights({ filename, chunk, completed: false });
            }
            await this.addon.loadWeights({ filename, chunk: null, completed: true });
            this.logger.info(`Streamed weights for ${filename}`);
        }
    }
    run(prompt, runOptions) {
        if (BatchHandler.isBatchInput(prompt)) {
            if (runOptions !== undefined) {
                throw new TypeError("Batch run options must be set per BatchPrompt item");
            }
            return this._run(() => this._runBatchInternal(prompt));
        }
        return this._run(() => this._runInternal(prompt, runOptions));
    }
    /**
     * True when the pool has no room for another request right now — the
     * fast-fail condition behind `rejectWhenBusy: true`.
     *
     * Capacity is consumed in scheduler slots, but a batch run of N prompts is
     * ONE job, so `activeJobs()` alone reports a full pool as `1` and would let
     * a caller who asked to fail fast be admitted and then block behind the
     * batch. `activeSlots()` measures the resource that actually runs out; the
     * job count still matters where slots are not the currency — `parallel: 1`
     * (no batch scheduler, slots always 0) and the window between admission and
     * slot enqueue — so capacity is the max of the two. Optional call so an
     * older/stubbed binding keeps working.
     *
     * A finetune needs its own check: it is exclusive, so it saturates the model
     * at any `parallel`, yet it occupies no slot and counts as a single job — so
     * neither counter reports a full pool for `parallel >= 2`.
     *
     * Fast-fail hint only, like the finetune check below: the native scheduler
     * is the authority, and slot state can change right after this read.
     */
    _atCapacity() {
        // An exclusive finetune holds the whole model however idle the counters
        // look. The response handler is live exactly while that job is queued or
        // running — it settles on the finetune's terminal event, on a submission
        // failure, and on unload — so it mirrors the scheduler's exclusiveActive_
        // flag on the JS side, without a binding round-trip.
        if (this._finetuneJob.active) {
            return true;
        }
        const addon = this.addon;
        const jobs = addon.activeJobs();
        const slots = addon.activeSlots?.() ?? 0;
        return Math.max(jobs, slots) >= this._maxConcurrency;
    }
    async _runBatchInternal(batchInput) {
        if (!this.addon) {
            throw new Error("Addon not initialized. Call load() first.");
        }
        // Same fast-fail pre-check as the single path, with the group policy
        // derived from the items' runOptions (they must agree — a batch is one
        // native job). Evaluated before the capacity check so a conflicting
        // batch is refused even when slots are free.
        if ((BatchHandler.groupRejectWhenBusy(batchInput) ?? this._rejectWhenBusy) &&
            this._atCapacity()) {
            throw runBusyError();
        }
        // Group state is dropped by the handler itself when the group's terminal
        // event (JobEnded / Error) lands, so concurrent batch runs stay isolated.
        const response = (await this._batchHandler.run(batchInput));
        const finalized = response.await();
        finalized.catch((err) => {
            this.logger?.warn?.("Batch inference response rejected:", err?.message || err);
        });
        response.await = () => finalized;
        return response;
    }
    async _runInternal(prompt, runOptions = {}) {
        if (!this.addon) {
            throw new Error("Addon not initialized. Call load() first.");
        }
        // Validated BEFORE the capacity pre-check so malformed options (null, a
        // truthy string, ...) fail as TypeErrors instead of steering admission.
        const { rejectWhenBusy } = normalizeRunOptions(runOptions);
        // rejectWhenBusy gates only this fast-fail pre-check: true rejects the moment
        // the pool is full (never queues); false falls through to the scheduler's
        // nearly unbounded queue, so it's only refused (below) under a runaway backlog.
        if ((rejectWhenBusy ?? this._rejectWhenBusy) && this._atCapacity()) {
            throw runBusyError();
        }
        this.logger.info("Starting inference with prompt:", sanitizePromptForLog(prompt));
        const promptMessages = promptToAddonMessages(prompt, runOptions);
        let jobId = null;
        const response = new infer_base_1.QvacResponse({
            cancelHandler: () => this.addon?.cancelJob(jobId),
        });
        /// The native addon mints the jobId and hands it back here. Single-threaded
        /// JS guarantees this resolves before any tagged output callback runs, so
        /// registering the sink afterwards never races the first chunk.
        let admission;
        try {
            admission = await this.addon.runJob(promptMessages);
        }
        catch (error) {
            response.failed(error);
            throw error;
        }
        // Unconditional even when rejectWhenBusy is false: a rejected job never runs
        // — the pool and queue are full, or an exclusive finetune holds the model —
        // so there is no response to return.
        if (!admission.accepted) {
            response.failed(runBusyError());
            throw runBusyError();
        }
        jobId = admission.id;
        this._jobSinks.set(jobId, response);
        const finalized = response.await().finally(() => {
            this._jobSinks.delete(jobId);
        });
        finalized.catch((err) => {
            this.logger?.warn?.("Inference response rejected:", err?.message || err);
        });
        response.await = () => finalized;
        this.logger.info("Inference job started successfully");
        return response;
    }
    finetune(finetuningOptions) {
        if (!finetuningOptions) {
            throw new Error("Finetuning parameters are required.");
        }
        const paramsToSend = normalizeFinetuneParams(finetuningOptions);
        this.logger.info("finetune() called");
        this.logger.info("Finetuning parameters:", finetuningOptions);
        return this._run(async () => {
            if (!this.addon) {
                throw new Error("Addon not initialized. Call load() first.");
            }
            // Refused while ANY job is active (not just at full concurrency): finetune
            // needs the model to itself. Fast-fail hint only — the native scheduler is
            // the authority via exclusive-job admission.
            if (this.addon.activeJobs() > 0) {
                throw runBusyError();
            }
            if (finetuningOptions.checkpointSaveDir) {
                this._checkpointSaveDir = finetuningOptions.checkpointSaveDir;
            }
            const response = this._finetuneJob.start();
            let accepted;
            try {
                accepted = await this.addon.finetune(paramsToSend);
            }
            catch (err) {
                this._finetuneJob.fail(err);
                throw err;
            }
            if (!accepted) {
                this._finetuneJob.fail(runBusyError());
                throw runBusyError();
            }
            // Native tags finetune events with the exclusive job's id (the
            // admission value): route them through _jobSinks like any other job.
            // Boolean stubs and legacy bindings skip registration.
            if (typeof accepted === "number") {
                this._jobSinks.set(accepted, this._finetuneSink(accepted));
            }
            const finalized = response.await();
            finalized.catch((err) => {
                this.logger?.warn?.("Finetune response rejected:", err?.message || err);
            });
            response.await = () => finalized;
            return response;
        });
    }
    /// Sink adapter registered under the finetune job's native id: tagged
    /// finetune events route here like any inference job's and forward to the
    /// finetune-only handler, whose idle no-ops make double settlement (e.g.
    /// unload) safe.
    _finetuneSink(jobId) {
        return {
            finetune: true,
            updateOutput: (data) => this._finetuneJob.output(data),
            // The finetune terminal is payload-routed (op/status) and the trailing
            // scheduler stats snapshot is not a finetune result: both no-op here.
            updateStats: () => { },
            ended: () => {
                this._jobSinks.delete(jobId);
            },
            failed: (error) => {
                this._jobSinks.delete(jobId);
                this._finetuneJob.fail(error);
            },
        };
    }
    /// Route an output event to the correct sink. A tagged event owned by an
    /// in-flight batch group goes to that group's response; other tagged events
    /// go to the per-job sink stored in _jobSinks (finetune registers an
    /// adapter under its native id). An event with no registered destination is
    /// dropped with a warning — never reinterpreted as belonging to another
    /// job. Streamed batch chunks stay untagged and route by their per-prompt
    /// string id; the finetune terminal is identified by its payload.
    _handleAddonOutputEvent(eventType, data, error, jobId) {
        if (eventType === "LogMsg") {
            const logMsg = typeof data === "string"
                ? data
                : data?.message || JSON.stringify(data);
            this.logger?.info?.(logMsg);
            return;
        }
        // A tagged event owned by an in-flight batch group routes to that group:
        // its terminal BatchResult / JobEnded (per-group stats) / Error settle the
        // group's own response, so concurrent batch runs never cross.
        if (this._batchHandler.owns(jobId)) {
            if (eventType === "Error") {
                this.logger.error("Batch job failed with error:", error);
                this._batchHandler.onError(jobId, error);
            }
            else if (eventType === "BatchResult") {
                this._batchHandler.onResult(jobId, data);
            }
            else if (eventType === "JobEnded") {
                this.logger.info("Batch job completed");
                this._batchHandler.onJobEnded(jobId, this.opts.stats ? data : null);
            }
            return;
        }
        const sink = typeof jobId === "number" ? this._jobSinks.get(jobId) : null;
        // Untagged (legacy bindings) stays payload-routed; tagged must own the sink.
        const ownsFinetune = typeof jobId === "number" ? sink?.finetune === true : true;
        if (eventType === "Error") {
            this.logger.error("Job failed with error:", error);
            if (sink) {
                sink.failed(error);
            }
            else {
                this.logger?.warn?.("Dropped Error event with no registered job:", jobId);
            }
        }
        else if (eventType === "BatchOutput") {
            // Streaming chunks are untagged; the handler routes them by their
            // per-prompt string id.
            this._batchHandler.onOutput(data);
        }
        else if (eventType === "Output") {
            if (sink) {
                sink.updateOutput(data);
            }
            else {
                this.logger?.warn?.("Dropped Output event with no registered job:", jobId);
            }
        }
        else if (eventType === "FinetuneProgress") {
            const progress = data;
            if (!ownsFinetune) {
                this.logger?.warn?.("Dropped FinetuneProgress event with no registered finetune job:", jobId);
            }
            else if (this.opts.stats && progress && progress.stats) {
                this._finetuneJob.active?.updateStats(progress.stats);
            }
        }
        else if (eventType === "JobEnded") {
            this.logger.info("Job completed");
            const terminal = data;
            const isFinetuneTerminal = !!terminal &&
                typeof terminal === "object" &&
                terminal.op === "finetune" &&
                typeof terminal.status === "string";
            if (isFinetuneTerminal) {
                if (ownsFinetune) {
                    // The sink stays registered so the scheduler's trailing jobEnded
                    // stats snapshot is consumed (and deregisters it) instead of
                    // surfacing as an unknown tagged event.
                    this._finetuneJob.end(null, data);
                }
                else {
                    this.logger?.warn?.("Dropped finetune JobEnded event with no registered finetune job:", jobId);
                }
            }
            else if (sink) {
                try {
                    if (this.opts.stats && data !== null)
                        sink.updateStats(data);
                }
                finally {
                    sink.ended();
                }
            }
            else {
                this.logger?.warn?.("Dropped JobEnded event with no registered job:", jobId);
            }
        }
    }
    /// Native output callback. The 5th arg carries the numeric jobId minted
    /// natively for single runs, batch groups, and finetune; only streamed
    /// batch chunks arrive untagged (routed by their per-prompt string id).
    _addonOutputCallback(addon, event, data, error, jobId) {
        const mapped = (0, addon_1.mapAddonEvent)(event, data, error);
        if (mapped === null)
            return;
        this._handleAddonOutputEvent(mapped.type, mapped.data, mapped.error, jobId);
    }
    /** Instantiate the native addon with the given parameters. */
    _createAddon(configurationParams) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- resolved lazily so this module loads without prebuilds.
        const binding = require("./binding");
        return new addon_1.LlamaInterface(binding, configurationParams, this._addonOutputCallback.bind(this));
    }
    /**
     * Pause finetuning, saving a checkpoint so training can resume later.
     * Also cancels any inference job in flight.
     */
    async pause() {
        if (this.addon?.cancel) {
            await this.addon.cancel(1);
        }
    }
    /**
     * Cancel finetuning and remove the pause checkpoint so the next
     * `finetune()` call starts fresh instead of resuming. Also cancels
     * any inference job in flight.
     */
    async cancel() {
        if (this.addon?.cancel) {
            await this.addon.cancel(0);
        }
        this._clearPauseCheckpoints();
    }
    _clearPauseCheckpoints() {
        const checkpointDir = this._checkpointSaveDir;
        if (!checkpointDir)
            return;
        try {
            // bare-fs types the `withFileTypes` overload as `Dir[]`; it yields entries.
            const entries = fs.readdirSync(checkpointDir, {
                withFileTypes: true,
            });
            for (const entry of entries) {
                if (entry.isDirectory() && entry.name.startsWith("pause_checkpoint_step_")) {
                    fs.rmSync(path.join(checkpointDir, entry.name), { recursive: true, force: true });
                }
            }
        }
        catch (err) {
            this.logger.error("Failed to clear pause checkpoints:", err);
        }
    }
    /**
     * Unload the model safely by cancelling the in-flight job and releasing
     * native resources. Subsequent calls to `run()` / `finetune()` / `cancel()`
     * are safe; they hit the `!this.addon` guard and throw or no-op.
     */
    unload() {
        return this._run(async () => {
            try {
                await this.pause();
            }
            catch { }
            // QvacResponse settlement emits to user listeners synchronously before
            // resolving/rejecting its finish promise, so a throwing listener unwinds
            // out of failed()/ended(). Isolate each settlement so one bad listener
            // cannot strand the remaining sinks or abort unload.
            const settleSafely = (fail) => {
                try {
                    fail();
                }
                catch (err) {
                    this.logger?.warn?.("Response listener threw during unload:", err?.message || err);
                }
            };
            try {
                if (this._finetuneJob.active) {
                    settleSafely(() => this._finetuneJob.fail(new Error("Model was unloaded")));
                }
                /// Settle every in-flight concurrent response before dropping it, or its
                /// awaiting run() caller would hang forever.
                for (const sink of this._jobSinks.values()) {
                    settleSafely(() => sink.failed(new Error("Model was unloaded")));
                }
                settleSafely(() => this._batchHandler.failAll(new Error("Model was unloaded")));
            }
            finally {
                // Native cleanup is unconditional: whatever settlement does, the
                // addon must be released and the instance left cleanly unloaded.
                this._jobSinks.clear();
                if (this.addon) {
                    await this.addon.unload();
                    // Null the addon reference so post-unload `cancel()` / `run()` calls hit the
                    // `if (!this.addon)` guard instead of dereferencing a disposed native handle.
                    this.addon = null;
                }
                this.state.configLoaded = false;
            }
        });
    }
    /// Backward-compatible accessor: true when the scheduler has an active job.
    /// Sourced from the native scheduler's activeJobs() — no JS-side counter.
    get _hasActiveResponse() {
        return (this.addon ? this.addon.activeJobs() : 0) > 0;
    }
    getState() {
        return this.state;
    }
};
// Runtime-redundant: ESM named imports need the top-level `module.exports.X =` form.
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- `module.exports` is untyped CommonJS surface. */
module.exports.pickPrimaryGgufPath = pickPrimaryGgufPath;
module.exports.QvacResponse = infer_base_1.QvacResponse;
module.exports = LlmLlamacpp;
/* eslint-enable @typescript-eslint/no-unsafe-member-access */
