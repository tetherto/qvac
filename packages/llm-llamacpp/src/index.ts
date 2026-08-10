/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
import fs = require("bare-fs");
import path = require("bare-path");
import QvacLogger = require("@qvac/logging");
import BatchHandler = require("./batchHandler");
/* eslint-enable @typescript-eslint/no-require-imports */
import { createJobHandler, exclusiveRunQueue, QvacResponse, type JobHandler } from "@qvac/infer-base";
import { LlamaInterface, mapAddonEvent } from "./addon";
import type * as AddonModule from "./addon";

const { runBusyError } = BatchHandler;

type BareEventMap = Record<string | symbol, unknown[]>;

/** Aliases: inside the namespace, `QvacResponse` resolves to its own member. */
type InferQvacResponse = QvacResponse;
type InferQvacResponseOf<Output> = QvacResponse<Output>;

/** Aliases so the class expression's body can name the namespace types below. */
type BatchPrompt = LlmLlamacpp.BatchPrompt;
type BatchResponse = LlmLlamacpp.BatchResponse;
type FinetuneHandle = LlmLlamacpp.FinetuneHandle;
type FinetuneOptions = LlmLlamacpp.FinetuneOptions;
type FinetuneProgressStats = LlmLlamacpp.FinetuneProgressStats;
type GenerationParams = LlmLlamacpp.GenerationParams;
type LlamaConfig = LlmLlamacpp.LlamaConfig;
type LlmLlamacppArgs = LlmLlamacpp.LlmLlamacppArgs;
type Message = LlmLlamacpp.Message;
type RunOptions = LlmLlamacpp.RunOptions;
type UserMediaMessage = LlmLlamacpp.UserMediaMessage;

/** `exclusiveRunQueue()` is published as `Promise<any>`; keep it generic here. */
type RunExclusive = <T>(fn: () => Promise<T>) => Promise<T>;

interface NormalizedRunOptions {
  prefill: boolean;
  generationParams: GenerationParams | undefined;
  cacheKey: string | undefined;
  saveCacheToDisk: boolean;
  rejectWhenBusy: boolean | undefined;
}

type FinetuneParamsPayload = Omit<FinetuneOptions, "validation"> & {
  validation?: LlmLlamacpp.FinetuneValidation;
  validationSplit?: number;
  useEvalDatasetForValidation?: boolean;
  evalDatasetPath?: string;
};

/** Destination for a job's tagged native events; `finetune` marks the adapter. */
interface JobSink {
  finetune?: boolean;
  updateOutput(data: unknown): void;
  updateStats(stats: unknown): void;
  ended(result?: unknown): void;
  failed(error: Error): void;
}

function normalizeRunOptions(runOptions: unknown): NormalizedRunOptions {
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

  const options = runOptions as RunOptions;

  if (options.prefill !== undefined && typeof options.prefill !== "boolean") {
    throw new TypeError("prefill must be a boolean when provided");
  }

  if (
    options.generationParams !== undefined &&
    (typeof options.generationParams !== "object" ||
      options.generationParams === null ||
      Array.isArray(options.generationParams))
  ) {
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

function promptToAddonMessages(
  prompt: Message[],
  runOptions?: RunOptions,
): AddonModule.AddonRunJobMessage[] {
  if (!Array.isArray(prompt)) {
    throw new TypeError("Prompt input must be Message[]");
  }

  const { prefill, generationParams, cacheKey, saveCacheToDisk } = normalizeRunOptions(runOptions);

  const textMessages: Message[] = [];
  const mediaItems: Uint8Array[] = [];

  for (const message of prompt) {
    const media = message as UserMediaMessage;
    if (media.role === "user" && media.type === "media" && media.content instanceof Uint8Array) {
      mediaItems.push(media.content);
      textMessages.push({ ...media, content: "" });
    } else {
      textMessages.push(message);
    }
  }

  const promptMessages: AddonModule.AddonRunJobMessage[] = [];

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
function normalizeGenerationParams(
  generationParams: GenerationParams | undefined,
): GenerationParams | undefined {
  if (generationParams === undefined) return undefined;

  if (
    generationParams.remove_thinking_from_context !== undefined &&
    typeof generationParams.remove_thinking_from_context !== "boolean"
  ) {
    throw new TypeError(
      "generationParams.remove_thinking_from_context must be a boolean when provided",
    );
  }

  const hasGrammar =
    typeof generationParams.grammar === "string" && generationParams.grammar.length > 0;
  const hasJsonSchema =
    generationParams.json_schema !== undefined &&
    generationParams.json_schema !== null &&
    !(typeof generationParams.json_schema === "string" && generationParams.json_schema.length === 0);

  if (hasGrammar && hasJsonSchema) {
    throw new TypeError(
      "generationParams.grammar and generationParams.json_schema are mutually exclusive",
    );
  }

  if (!hasJsonSchema) return generationParams;

  let jsonSchemaString: string;
  if (typeof generationParams.json_schema === "string") {
    jsonSchemaString = generationParams.json_schema;
  } else if (
    typeof generationParams.json_schema === "object" &&
    !Array.isArray(generationParams.json_schema)
  ) {
    try {
      jsonSchemaString = JSON.stringify(generationParams.json_schema);
    } catch (err) {
      throw new TypeError(
        "generationParams.json_schema is not JSON-serializable: " + (err as Error).message,
      );
    }
  } else {
    throw new TypeError(
      "generationParams.json_schema must be a JSON Schema object or a JSON Schema string",
    );
  }

  return { ...generationParams, json_schema: jsonSchemaString };
}

const VALIDATION_TYPES = ["none", "split", "dataset"];
const DEFAULT_VALIDATION_FRACTION = 0.05;
/// Upper bound for `parallel`, mirroring K_MAX_PARALLEL_WORKERS in
/// addon/src/addon/AddonJs.hpp — the engine's own n_seq_max ceiling
/// (LLAMA_MAX_SEQ in qvac-fabric). Keep the two in sync.
const MAX_PARALLEL = 256;

function normalizeFinetuneParams(opts: FinetuneOptions): FinetuneParamsPayload {
  const validation = opts.validation;
  if (Object.prototype.hasOwnProperty.call(opts, "evalDatasetPath")) {
    throw new Error(
      "Top-level evalDatasetPath is no longer supported. Use validation.path with validation.type set to 'dataset'.",
    );
  }
  if (
    validation === null ||
    validation === undefined ||
    typeof validation !== "object" ||
    !("type" in validation)
  ) {
    throw new Error(
      "Finetuning options must include validation: { type: 'none' | 'split' | 'dataset'[, fraction?: number][, path?: string] }. " +
        "Example: validation: { type: 'split', fraction: 0.05 }, validation: { type: 'dataset', path: './eval.jsonl' }, or validation: { type: 'none' }.",
    );
  }
  const out: FinetuneParamsPayload = { ...opts };
  const type = validation.type;
  if (!VALIDATION_TYPES.includes(type)) {
    throw new Error(`validation.type must be one of ${VALIDATION_TYPES.join(", ")}; got: ${type}`);
  }
  if (type === "none") {
    out.validationSplit = 0;
    out.useEvalDatasetForValidation = false;
    delete out.evalDatasetPath;
  } else if (type === "split") {
    const fraction = validation.fraction ?? DEFAULT_VALIDATION_FRACTION;
    out.validationSplit = Math.max(0, Math.min(1, Number(fraction)));
    out.useEvalDatasetForValidation = false;
    delete out.evalDatasetPath;
  } else {
    const evalPath = validation.path;
    if (!evalPath || typeof evalPath !== "string" || evalPath.trim() === "") {
      throw new Error(
        "validation.type is 'dataset' but no path is provided. Set validation.path to the eval dataset file path (e.g. validation: { type: 'dataset', path: './eval.jsonl' }).",
      );
    }
    if (evalPath === opts.trainDatasetDir) {
      throw new Error(
        "validation.type is 'dataset' but validation.path is the same as trainDatasetDir. Provide a separate eval dataset path.",
      );
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
function pickPrimaryGgufPath(files: string[]): string {
  const SHARD_REGEX = /-\d+-of-\d+\.gguf$/;
  return files.find((p) => SHARD_REGEX.test(p)) || files[0];
}

// Replace media Uint8Array contents with a small summary so the logger never
// asks V8 to JSON.stringify multi-MB binary blobs.
function sanitizePromptForLog(prompt: Message[]): unknown {
  if (!Array.isArray(prompt)) return prompt;
  return prompt.map((msg) => {
    const media = msg as UserMediaMessage;
    if (media && media.type === "media" && media.content instanceof Uint8Array) {
      return { ...media, content: `[Uint8Array byteLength=${media.content.byteLength}]` };
    }
    return msg;
  });
}

// An interface rather than the class type, so private fields stay out of the
// generated declarations.
interface LlmLlamacpp {
  /** The native addon, or `null` before `load()` and after `unload()`. Advanced/test access only. */
  addon: LlmLlamacpp.Addon | null;
  opts: { stats?: boolean };
  logger: QvacLogger;
  state: { configLoaded: boolean };

  load(): Promise<void>;
  /**
   * Run inference. When the model was loaded with `config.parallel >= 2`,
   * multiple `run()` calls may be concurrently in flight (continuous
   * batching): separate top-level calls are decoded together across slots,
   * and each call returns an independent `QvacResponse` that receives only
   * its own output tokens and stats. A call at capacity throws an `Error` with `code === 'RUN_BUSY'`
   * when the effective `rejectWhenBusy` policy is `true` (the default for
   * `parallel: 1`), and queues until a slot frees when it is `false` (the
   * default for `parallel >= 2`). Use `response.cancel()` to cancel just
   * that call's job or batch group.
   */
  run(prompt: Message[], runOptions?: RunOptions): Promise<LlmLlamacpp.QvacResponse>;
  run(prompt: (Message[] | BatchPrompt)[]): Promise<BatchResponse>;
  finetune(finetuningOptions: FinetuneOptions): Promise<FinetuneHandle>;
  /**
   * Global cancel: stops every job live at the moment of the call — in-flight
   * and queued, across all concurrent `run()` calls — plus any finetuning in
   * progress (its pause checkpoint is removed so the next `finetune()` starts
   * fresh). For cancelling a single request or batch group, use
   * `response.cancel()` on that call's response instead.
   */
  cancel(): Promise<void>;
  pause(): Promise<void>;
  unload(): Promise<void>;
  getState(): { configLoaded: boolean };
}

interface LlmLlamacppConstructor {
  new (args: LlmLlamacppArgs): LlmLlamacpp;
  readonly prototype: LlmLlamacpp;
  /** Returns the first shard (matching `-NNNNN-of-MMMMM.gguf`) or the sole entry for single-file models. */
  readonly pickPrimaryGgufPath: typeof pickPrimaryGgufPath;
}

/** LLM client wrapping the native LlamaInterface for inference, finetuning, and pause/resume. */
const LlmLlamacpp: LlmLlamacppConstructor = class LlmLlamacpp {
  static readonly pickPrimaryGgufPath = pickPrimaryGgufPath;
  // Attached for tests; untyped because `typeof QvacResponse` is not nameable by consumers.
  static readonly QvacResponse = QvacResponse;

  addon: LlamaInterface | null;
  opts: { stats?: boolean; rejectWhenBusy?: boolean };
  logger: QvacLogger;
  state: { configLoaded: boolean };

  private readonly _files: string[];
  private readonly _projectionModelPath: string;
  private readonly _config: LlamaConfig | undefined;
  private readonly _finetuneJob: JobHandler;
  private readonly _run: RunExclusive;
  private readonly _maxConcurrency: number;
  private readonly _rejectWhenBusy: boolean;
  private readonly _jobSinks: Map<number, JobSink>;
  private readonly _batchHandler: BatchHandler;
  private _checkpointSaveDir: string | null;

  constructor({ files, config, logger = null, opts = {} }: LlmLlamacppArgs) {
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
        throw new TypeError(
          `files.projectionModel must be an absolute path (got: ${files.projectionModel})`,
        );
      }
    }
    this._files = files.model;
    this._projectionModelPath = files.projectionModel || "";
    this._config = config;
    this.logger = new QvacLogger(logger as QvacLogger.LoggerInterface);
    this.opts = opts;
    // Finetune-only response holder. Tagged finetune events reach it through
    // the _finetuneSink adapter registered in _jobSinks under the exclusive
    // job's native id; inference never touches this handler.
    // Lazy deref + optional chain: safe before `_load()` and after `unload()`.
    this._finetuneJob = createJobHandler({ cancel: () => this.addon?.cancel() });
    this._run = exclusiveRunQueue() as RunExclusive;
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
      if (
        !/^[0-9]+$/.test(String(config.parallel)) ||
        !Number.isSafeInteger(parallel) ||
        parallel < 1 ||
        parallel > MAX_PARALLEL
      ) {
        throw new TypeError(`parallel must be an integer between 1 and ${MAX_PARALLEL}`);
      }
      this._maxConcurrency = parallel;
    } else {
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
      cancelHandler: (jobId: number | null) => this.addon?.cancelJob(jobId as number),
      runJob: (items) => (this.addon as LlamaInterface).runJob(items),
    });
    this.state = { configLoaded: false };
  }

  load(): Promise<void> {
    return this._run(async () => {
      if (this.state.configLoaded) return;
      await this._load();
      this.state.configLoaded = true;
    });
  }

  private async _load(): Promise<void> {
    this.logger.info("Starting model load");
    const primaryGgufPath = pickPrimaryGgufPath(this._files);
    const configurationParams = {
      path: primaryGgufPath,
      projectionPath: this._projectionModelPath,
      config: { ...this._config } as Record<string, unknown>,
    };

    this.logger.info("Creating addon with configuration:", configurationParams);

    try {
      this.addon = this._createAddon(configurationParams);
      if (this._files.length > 1) {
        await this._streamShards();
      }
      this.logger.info("Activating addon");
      await this.addon.activate();
    } catch (loadError) {
      this.logger.error("Error during model load:", loadError);
      // Best-effort cleanup of the partially-initialized addon so a subsequent
      // load() does not leak a zombie native instance.
      try {
        await this.addon?.unload?.();
      } catch {}
      this.addon = null;
      throw loadError;
    }
    this.logger.info("Model load completed successfully");
  }

  private async _streamShards(): Promise<void> {
    for (const filePath of this._files) {
      const filename = path.basename(filePath);
      const stream = fs.createReadStream(filePath) as AsyncIterable<Uint8Array>;
      for await (const chunk of stream) {
        await (this.addon as LlamaInterface).loadWeights({ filename, chunk, completed: false });
      }
      await (this.addon as LlamaInterface).loadWeights({ filename, chunk: null, completed: true });
      this.logger.info(`Streamed weights for ${filename}`);
    }
  }

  run(prompt: Message[], runOptions?: RunOptions): Promise<QvacResponse>;
  run(prompt: (Message[] | BatchPrompt)[]): Promise<BatchResponse>;
  run(
    prompt: Message[] | (Message[] | BatchPrompt)[],
    runOptions?: RunOptions,
  ): Promise<QvacResponse | BatchResponse> {
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
  private _atCapacity(): boolean {
    // An exclusive finetune holds the whole model however idle the counters
    // look. The response handler is live exactly while that job is queued or
    // running — it settles on the finetune's terminal event, on a submission
    // failure, and on unload — so it mirrors the scheduler's exclusiveActive_
    // flag on the JS side, without a binding round-trip.
    if (this._finetuneJob.active) {
      return true;
    }
    const addon = this.addon as LlamaInterface;
    const jobs = addon.activeJobs();
    const slots = addon.activeSlots?.() ?? 0;
    return Math.max(jobs, slots) >= this._maxConcurrency;
  }

  private async _runBatchInternal(batchInput: (Message[] | BatchPrompt)[]): Promise<BatchResponse> {
    if (!this.addon) {
      throw new Error("Addon not initialized. Call load() first.");
    }
    // Same fast-fail pre-check as the single path, with the group policy
    // derived from the items' runOptions (they must agree — a batch is one
    // native job). Evaluated before the capacity check so a conflicting
    // batch is refused even when slots are free.
    if (
      (BatchHandler.groupRejectWhenBusy(batchInput) ?? this._rejectWhenBusy) &&
      this._atCapacity()
    ) {
      throw runBusyError();
    }

    // Group state is dropped by the handler itself when the group's terminal
    // event (JobEnded / Error) lands, so concurrent batch runs stay isolated.
    const response = (await this._batchHandler.run(batchInput)) as unknown as BatchResponse;

    const finalized = response.await();
    finalized.catch((err: unknown) => {
      this.logger?.warn?.("Batch inference response rejected:", (err as Error)?.message || err);
    });
    response.await = () => finalized;

    return response;
  }

  private async _runInternal(
    prompt: Message[],
    runOptions: RunOptions = {},
  ): Promise<QvacResponse> {
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

    let jobId: number | null = null;
    const response = new QvacResponse({
      cancelHandler: () => this.addon?.cancelJob(jobId as number) as Promise<void>,
    });

    /// The native addon mints the jobId and hands it back here. Single-threaded
    /// JS guarantees this resolves before any tagged output callback runs, so
    /// registering the sink afterwards never races the first chunk.
    let admission: AddonModule.AddonRunJobResult;
    try {
      admission = await this.addon.runJob(promptMessages);
    } catch (error) {
      response.failed(error as Error);
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
    finalized.catch((err: unknown) => {
      this.logger?.warn?.("Inference response rejected:", (err as Error)?.message || err);
    });
    response.await = () => finalized;

    this.logger.info("Inference job started successfully");
    return response;
  }

  finetune(finetuningOptions?: FinetuneOptions): Promise<FinetuneHandle> {
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
      let accepted: number | false;
      try {
        accepted = await this.addon.finetune(paramsToSend as unknown as FinetuneOptions);
      } catch (err) {
        this._finetuneJob.fail(err as Error);
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
      finalized.catch((err: unknown) => {
        this.logger?.warn?.("Finetune response rejected:", (err as Error)?.message || err);
      });
      response.await = () => finalized;
      return response as unknown as FinetuneHandle;
    });
  }

  /// Sink adapter registered under the finetune job's native id: tagged
  /// finetune events route here like any inference job's and forward to the
  /// finetune-only handler, whose idle no-ops make double settlement (e.g.
  /// unload) safe.
  private _finetuneSink(jobId: number): JobSink {
    return {
      finetune: true,
      updateOutput: (data: unknown) => this._finetuneJob.output(data),
      // The finetune terminal is payload-routed (op/status) and the trailing
      // scheduler stats snapshot is not a finetune result: both no-op here.
      updateStats: () => {},
      ended: () => {
        this._jobSinks.delete(jobId);
      },
      failed: (error: Error) => {
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
  private _handleAddonOutputEvent(
    eventType: string,
    data: unknown,
    error: unknown,
    jobId: unknown,
  ): void {
    if (eventType === "LogMsg") {
      const logMsg =
        typeof data === "string"
          ? data
          : (data as { message?: string })?.message || JSON.stringify(data);
      this.logger?.info?.(logMsg);
      return;
    }

    // A tagged event owned by an in-flight batch group routes to that group:
    // its terminal BatchResult / JobEnded (per-group stats) / Error settle the
    // group's own response, so concurrent batch runs never cross.
    if (this._batchHandler.owns(jobId)) {
      if (eventType === "Error") {
        this.logger.error("Batch job failed with error:", error);
        this._batchHandler.onError(jobId, error as Error);
      } else if (eventType === "BatchResult") {
        this._batchHandler.onResult(jobId, data as string[]);
      } else if (eventType === "JobEnded") {
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
        sink.failed(error as Error);
      } else {
        this.logger?.warn?.("Dropped Error event with no registered job:", jobId);
      }
    } else if (eventType === "BatchOutput") {
      // Streaming chunks are untagged; the handler routes them by their
      // per-prompt string id.
      this._batchHandler.onOutput(data as { id: string; output: string });
    } else if (eventType === "Output") {
      if (sink) {
        sink.updateOutput(data);
      } else {
        this.logger?.warn?.("Dropped Output event with no registered job:", jobId);
      }
    } else if (eventType === "FinetuneProgress") {
      const progress = data as { stats?: FinetuneProgressStats } | null;
      if (!ownsFinetune) {
        this.logger?.warn?.("Dropped FinetuneProgress event with no registered finetune job:", jobId);
      } else if (this.opts.stats && progress && progress.stats) {
        this._finetuneJob.active?.updateStats(progress.stats);
      }
    } else if (eventType === "JobEnded") {
      this.logger.info("Job completed");
      const terminal = data as { op?: string; status?: string } | null;
      const isFinetuneTerminal =
        !!terminal &&
        typeof terminal === "object" &&
        terminal.op === "finetune" &&
        typeof terminal.status === "string";
      if (isFinetuneTerminal) {
        if (ownsFinetune) {
          // The sink stays registered so the scheduler's trailing jobEnded
          // stats snapshot is consumed (and deregisters it) instead of
          // surfacing as an unknown tagged event.
          this._finetuneJob.end(null, data);
        } else {
          this.logger?.warn?.(
            "Dropped finetune JobEnded event with no registered finetune job:",
            jobId,
          );
        }
      } else if (sink) {
        try {
          if (this.opts.stats && data !== null) sink.updateStats(data);
        } finally {
          sink.ended();
        }
      } else {
        this.logger?.warn?.("Dropped JobEnded event with no registered job:", jobId);
      }
    }
  }

  /// Native output callback. The 5th arg carries the numeric jobId minted
  /// natively for single runs, batch groups, and finetune; only streamed
  /// batch chunks arrive untagged (routed by their per-prompt string id).
  private _addonOutputCallback(
    addon: unknown,
    event: unknown,
    data: unknown,
    error: unknown,
    jobId: unknown,
  ): void {
    const mapped = mapAddonEvent(event, data, error);
    if (mapped === null) return;
    this._handleAddonOutputEvent(mapped.type, mapped.data, mapped.error, jobId);
  }

  /** Instantiate the native addon with the given parameters. */
  private _createAddon(
    configurationParams: AddonModule.AddonConfigurationParams,
  ): LlamaInterface {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- resolved lazily so this module loads without prebuilds.
    const binding = require("./binding") as unknown;
    return new LlamaInterface(binding, configurationParams, this._addonOutputCallback.bind(this));
  }

  /**
   * Pause finetuning, saving a checkpoint so training can resume later.
   * Also cancels any inference job in flight.
   */
  async pause(): Promise<void> {
    if (this.addon?.cancel) {
      await this.addon.cancel(1);
    }
  }

  /**
   * Cancel finetuning and remove the pause checkpoint so the next
   * `finetune()` call starts fresh instead of resuming. Also cancels
   * any inference job in flight.
   */
  async cancel(): Promise<void> {
    if (this.addon?.cancel) {
      await this.addon.cancel(0);
    }
    this._clearPauseCheckpoints();
  }

  private _clearPauseCheckpoints(): void {
    const checkpointDir = this._checkpointSaveDir;
    if (!checkpointDir) return;
    try {
      // bare-fs types the `withFileTypes` overload as `Dir[]`; it yields entries.
      const entries = fs.readdirSync(checkpointDir, {
        withFileTypes: true,
      }) as unknown as fs.Dirent<string>[];
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith("pause_checkpoint_step_")) {
          fs.rmSync(path.join(checkpointDir, entry.name), { recursive: true, force: true });
        }
      }
    } catch (err) {
      this.logger.error("Failed to clear pause checkpoints:", err);
    }
  }

  /**
   * Unload the model safely by cancelling the in-flight job and releasing
   * native resources. Subsequent calls to `run()` / `finetune()` / `cancel()`
   * are safe; they hit the `!this.addon` guard and throw or no-op.
   */
  unload(): Promise<void> {
    return this._run(async () => {
      try {
        await this.pause();
      } catch {}
      // QvacResponse settlement emits to user listeners synchronously before
      // resolving/rejecting its finish promise, so a throwing listener unwinds
      // out of failed()/ended(). Isolate each settlement so one bad listener
      // cannot strand the remaining sinks or abort unload.
      const settleSafely = (fail: () => void) => {
        try {
          fail();
        } catch (err) {
          this.logger?.warn?.("Response listener threw during unload:", (err as Error)?.message || err);
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
      } finally {
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
  private get _hasActiveResponse(): boolean {
    return (this.addon ? this.addon.activeJobs() : 0) > 0;
  }

  getState(): { configLoaded: boolean } {
    return this.state;
  }
};

// Types-only: a value member here would stop the namespace merging with the const above.
// eslint-disable-next-line @typescript-eslint/no-namespace -- the only way to type a constructor-first CommonJS export.
namespace LlmLlamacpp {
  export type NumericLike = number | `${number}`;

  export type AddonMessage = AddonModule.AddonMessage;
  export type AddonMediaMessage = AddonModule.AddonMediaMessage;
  export type AddonRunJobMessage = AddonModule.AddonRunJobMessage;
  /**
   * Discriminated admission result: the native binding only sets `id` when the
   * scheduler minted one, so a job id exists exactly when the job was accepted.
   */
  export type AdmissionResult = AddonModule.AdmissionResult;
  export type AddonRunJobResult = AddonModule.AddonRunJobResult;
  export type AddonBatchRunItem = AddonModule.AddonBatchRunItem;
  /**
   * Batch admission result. The per-sequence `ids` are reported on both
   * branches (they are assigned while parsing the batch input); the native
   * group id used to route the batch's terminal events exists only when the
   * batch was accepted.
   */
  export type AddonBatchRunResult = AddonModule.AddonBatchRunResult;

  export interface Addon {
    loadWeights(
      data: { filename: string; chunk: Uint8Array | null; completed: boolean },
      logger?: QvacLogger,
    ): Promise<void>;
    activate(): Promise<void>;
    /** Single-request admission: resolves the accepted flag plus the native-assigned job id. */
    runJob(data: AddonRunJobMessage[]): Promise<AddonRunJobResult>;
    /** Batch admission: resolves the accepted flag plus the assigned sequence ids. */
    runJob(data: AddonBatchRunItem[]): Promise<AddonBatchRunResult>;
    cancel(): Promise<void>;
    /** Cancel a single job by its native-assigned id, leaving other concurrent jobs running. */
    cancelJob(id: number): Promise<void>;
    /** Active jobs (in-flight + queued) per the native scheduler — the authoritative admission count. */
    activeJobs(): number;
    /**
     * Requests occupying or waiting for a continuous-batching slot
     * (active + pending). Capacity is consumed in slots, not jobs — one batch
     * job of N prompts takes up to N — so admission compares the max of this and
     * `activeJobs()` against `parallel`. 0 when no batch scheduler is active
     * (`parallel: 1`). Optional: an older binding may not export it.
     */
    activeSlots?(): number;
    /** Resolves the scheduler-minted exclusive-job id when admitted, `false` when rejected. */
    finetune?(params: FinetuneOptions): Promise<number | false>;
    unload(): Promise<void>;
  }

  export interface LlamaConfig {
    device?: string;
    gpu_layers?: NumericLike;
    ctx_size?: NumericLike;
    system_prompt?: string;
    lora?: string;
    temp?: NumericLike;
    top_p?: NumericLike;
    top_k?: NumericLike;
    predict?: NumericLike;
    seed?: NumericLike;
    no_mmap?: "" | "true" | "false";
    reverse_prompt?: string;
    repeat_penalty?: NumericLike;
    presence_penalty?: NumericLike;
    frequency_penalty?: NumericLike;
    tools?: boolean | string;
    verbosity?: NumericLike;
    n_discarded?: NumericLike;
    // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- `NumericLike` documents the expected form; any string is accepted.
    "main-gpu"?: NumericLike | string;
    /**
     * How to split the model across GPUs: 'none' (default, single GPU), 'layer'
     * (pipeline parallelism), 'row' (tensor parallelism).
     *
     * 'row' needs split buffers, which only the SYCL backend provides as of
     * qvac-fabric v10069 — no backend this package ships does. It is accepted but
     * degraded to 'layer' at load with a WARNING, so it behaves like 'layer'. See
     * docs/multi-gpu.md.
     */
    "split-mode"?: "none" | "layer" | "row";
    /** Proportions for distributing layers/rows across GPUs (e.g. '1,1' for equal split, '3,1' for 75/25). */
    "tensor-split"?: string;
    "cache-type-k"?: string;
    "cache-type-v"?: string;
    /**
     * Run the multimodal projector (mmproj / vision encoder) on the GPU. Accepts
     * 'true'/'on'/'1' or 'false'/'off'/'0'. When unset, the backend is auto-selected
     * per device class: GPU on desktop/iOS and Android Adreno 800+; CPU on all other
     * Android GPUs (Arm Mali, Adreno <800, and GPUs whose Adreno tier can't be
     * detected) — the LLM layers still run on the GPU while the projector stays on
     * CPU. Only honoured when a GPU backend is selected (ignored with a warning on CPU).
     */
    "mmproj-use-gpu"?: string;
    /** Writable directory for OpenCL kernel binary cache. Required on Android for fast GPU startup. */
    openclCacheDir?: string;
    /**
     * Reasoning channel budget. `-1` (default) leaves the model's reasoning
     * channel on; `0` disables it; any positive integer caps the reasoning
     * channel at that many tokens (the sampler force-emits `</think>` once
     * the budget is exhausted).
     */
    reasoning_budget?: number | `${number}`;
    /**
     * Number of concurrent sequence slots for continuous-batching (`--parallel` /
     * `n_parallel` in llama.cpp). Values `>= 2` activate the continuous-batch
     * scheduler: the prompts of a single batch-array `run()` call and separate
     * concurrent top-level `run()` calls are both decoded together across slots,
     * so multiple responses can be active at once. Default `1` (sequential, a
     * single response active at a time, batching disabled).
     *
     * Cost: `parallel` is a real resource commitment, sized upfront so a busy
     * server is ready to serve at full concurrency with no warm-up. It sizes
     * the native scheduler's worker pool one-to-one — that many OS threads are
     * created at load and held for the model's lifetime, idle or not — and the
     * KV cache is split evenly across the slots (each gets `ctx_size /
     * parallel` tokens). Size it to the concurrency you actually intend to
     * serve, not to a generous upper bound.
     *
     * Range `1..256`. The upper bound is the engine's own sequence limit
     * (`LLAMA_MAX_SEQ`): a larger value is rejected up front rather than
     * spawning its whole thread pool and then failing the model load with a
     * generic error. `ctx_size / parallel` must also leave at least one token
     * per slot, so a `parallel` too large for the context is refused as an
     * `InvalidArgument` naming both knobs.
     */
    parallel?: NumericLike;
    [key: string]: string | number | boolean | string[] | undefined;
  }

  export interface LlmLlamacppArgs {
    files: { model: string[]; projectionModel?: string };
    config: LlamaConfig;
    logger?: QvacLogger | Console | null;
    /**
     * `rejectWhenBusy` is the instance-level admission policy when the worker
     * pool is full; defaults to `true` for `parallel: 1` and `false` for
     * `parallel >= 2`, and can be overridden per call via
     * `RunOptions.rejectWhenBusy` (see its doc for the full contract).
     */
    opts?: { stats?: boolean; rejectWhenBusy?: boolean };
  }

  export interface UserTextMessage {
    // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- the literals document the known roles; any string is accepted.
    role: "system" | "assistant" | "user" | "tool" | "session" | string;
    content: string;
    type?: undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- arbitrary caller-supplied fields ride along to the chat template.
    [key: string]: any;
  }

  export interface UserMediaMessage {
    role: "user";
    type: "media";
    /**
     * Either the raw bytes of an image/audio/video file (`Uint8Array`) or an
     * absolute path to a file on disk (`string`). Path-mode is handled by the
     * C++ layer via `loadMedia()`; byte-mode takes the `parseMedia` path.
     */
    content: Uint8Array | string;
  }

  export interface ChatFunctionDefinition {
    type: "function";
    name: string;
    description?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an arbitrary JSON Schema.
    parameters?: Record<string, any>;
  }

  export type Message = UserTextMessage | UserMediaMessage | ChatFunctionDefinition;

  export interface GenerationParams {
    temp?: number;
    top_p?: number;
    top_k?: number;
    predict?: number;
    seed?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    repeat_penalty?: number;
    /**
     * GBNF grammar applied per request to constrain sampling. Equivalent to
     * the load-time `--grammar` config but scoped to a single `run()` call;
     * the sampler is re-initialized with this grammar for the request and
     * the prior grammar is restored afterwards.
     *
     * `undefined` or an empty string is treated as "no override" and falls
     * through to whatever grammar was set at load time (typically none).
     *
     * Mutually exclusive with `json_schema` — passing both throws.
     */
    grammar?: string;
    /**
     * JSON Schema applied per request to constrain sampling to valid JSON
     * matching the schema. Equivalent to the load-time `--json-schema`
     * config but scoped to a single `run()` call; the schema is converted
     * to GBNF natively (via llama.cpp's `json_schema_to_grammar()`) and
     * applied identically to `grammar`.
     *
     * Accepts either a JSON Schema object literal or a pre-stringified
     * JSON Schema. Mutually exclusive with `grammar` — passing both throws.
     */
    json_schema?: string | Record<string, unknown>;
    /**
     * Per-request reasoning channel budget. `-1` keeps the model's reasoning
     * channel on; `0` disables it for this request; any positive integer caps
     * the reasoning channel at that many tokens. Equivalent to the load-time
     * `reasoning_budget` config but scoped to a single `run()` call; the prior
     * value is restored afterwards.
     */
    reasoning_budget?: number;
    /**
     * When the model emits a reasoning block during generation (e.g.
     * `<think>...</think>` for the Qwen3 family, `<|channel>thought ...
     * <channel|>` for Gemma 4), drop those tokens from the KV cache at
     * end-of-generation so subsequent turns do not accumulate reasoning
     * history.
     *
     * Defaults to `false` for all models except the Qwen3 reasoning family
     * (Qwen3, Qwen3.5, and Qwen3.6, including MoE variants), which defaults
     * to `true`. Set this per-request `generationParams` value to override the
     * model default. Set to `false` to preserve reasoning tokens in the KV / SSM
     * cache across turns (e.g. chain-of-thought agents that want the next turn
     * to attend to prior reasoning, interpretability tooling, or cache-reuse
     * patterns that depend on the reasoning-inclusive state). Supported on both
     * text and multimodal contexts. No-op for models without a recognised
     * reasoning channel.
     *
     * Recurrent / hybrid-SSM models (Qwen3.5, Qwen3-Next, Jamba,
     * Granite-Hybrid, ...) are supported when the reasoning close
     * marker tokenises to a single vocab token. The recurrent half of
     * the memory module is snapshotted at the end-of-prefill boundary
     * and restored at end-of-generation. The replay buffer then feeds
     * any generated-opener seed tokens, the canonical close marker, and
     * the post-reasoning tail back through the decoder so both KV halves
     * stay consistent. Chat templates that force-open the reasoning
     * channel during prefill and templates that let the model generate
     * the opener are both supported: on the generated-opener path, every
     * sampled token from end-of-prefill up to and including the opener
     * flip is seeded into the replay buffer so the restored snapshot
     * still lands in a balanced `<think>...</think>` state on the next
     * turn. If a hybrid / recurrent model uses a multi-token close
     * marker while this feature is enabled, the request fails with
     * `StatusError` instead of silently preserving reasoning in cache.
     * Prefill-only
     * (cache-warm) requests are exempt from this check: they never
     * enter generation and cannot emit reasoning tokens, so a cache
     * warm on a non-conforming hybrid model still succeeds.
     *
     * Uniform hard-fail contract: any inability to remove the reasoning
     * span from cache — whether the end-of-prefill boundary snapshot
     * capture, the pure-attention `seq_rm + seq_add` primitive, the
     * hybrid restore / replay step, or an unsupported multi-token
     * recurrent close marker — is surfaced to the caller as a
     * `StatusError`. There is no soft-failure counter: if the feature is
     * enabled and cache cleanup cannot complete, the final request result is
     * failed rather than reported as a successful answer with the reasoning span
     * still resident in cache.
     *
     * Streaming caveat: token callbacks (`outputCallback` / batch `onToken`) are
     * invoked during generation, while reasoning-block compaction runs at
     * end-of-generation. If compaction fails, streaming callers may already have
     * received partial or complete text. Treat streamed text as tentative until
     * the request completes successfully; non-streaming callers receive no
     * successful returned answer on this failure path.
     *
     * Before throwing, the affected sequence is cleaned up so that the
     * next request on the same context starts from a coherent state:
     *   * Pure-attention `seq_rm + seq_add` rejection — the primitive
     *     is documented all-or-nothing, so live KV is unchanged when
     *     compaction is rejected. The driver drops the current
     *     request's contribution (`[preRequestCursor, currentCursor)`)
     *     from live memory and restores its positional accounting to
     *     the pre-request cursor before throwing, so both driver
     *     metadata and live KV agree on the pre-request state.
     *   * Boundary-capture or hybrid restore / replay failure — the
     *     driver rolls back to its pre-request checkpoint (or clears
     *     the sequence entirely on restore underflow) and resets
     *     positional accounting so subsequent turns cannot decode into
     *     contaminated positions.
     *
     * On the continuous-batch path, the scheduler's error-recovery leg
     * deliberately does NOT persist the failed slot's cache: when the
     * request was configured with `cacheKey` + `saveCacheToDisk`, the
     * last known-good on-disk cache is preserved rather than being
     * overwritten with the post-failure state. The same skip-save rule
     * applies to graceful cancels of hybrid / recurrent requests when
     * rollback to the pre-request cursor cannot be completed (recurrent
     * full-state restore refused, or no pre-request snapshot was captured
     * yet the driver has advanced past the pre-request cursor). Cancels
     * that can be rolled back cleanly still persist as usual.
     */
    remove_thinking_from_context?: boolean;
  }

  export interface RunOptions {
    /**
     * Run prefill only (cache warming): the prompt is evaluated but no tokens
     * are generated. On a model loaded with `parallel >= 2` a prefill is
     * admitted only when it is *persistable* (`saveCacheToDisk: true` plus a
     * `cacheKey`) — a live-only prefill warms context state that no concurrent
     * job could reach and is rejected with `InvalidArgument`; run live-only
     * prefills on a `parallel: 1` model. The same rule applies per batch item.
     */
    prefill?: boolean;
    generationParams?: GenerationParams;
    cacheKey?: string;
    /**
     * When `true` and `cacheKey` is set, the driver persists the sequence's
     * KV / recurrent state to disk under `cacheKey` at end-of-generation so a
     * later run keyed by the same string can resume without re-prefilling.
     *
     * The continuous-batch scheduler intentionally SKIPS the save on
     * teardown legs where persistence could corrupt the last known-good
     * on-disk cache:
     *   - Any batch error-recovery path (e.g. decode failure, per-slot
     *     failure with `SaveCachePolicy::Skip`, or a
     *     `remove_thinking_from_context` hard-fail).
     *   - Graceful cancel of a hybrid / recurrent request whose driver
     *     cannot roll live memory back to the pre-request cursor —
     *     either the recurrent full-state restore was refused, or no
     *     pre-request snapshot exists yet the driver advanced past the
     *     pre-request cursor. Cancels that roll back cleanly still save.
     *
     * On both skip paths the sequence's in-memory KV is still cleared, so
     * subsequent requests decode from a coherent baseline; only the
     * on-disk cache is untouched. Pure-attention drivers always roll back
     * via `removeLastNTokens` and therefore save on cancel as usual.
     */
    saveCacheToDisk?: boolean;
    /**
     * Admission policy when the worker pool is full. `true` rejects before
     * submitting with an `Error` carrying `code === 'RUN_BUSY'` — branch on the
     * code, not the message. `false` submits to the native multi-job
     * scheduler, which queues the job in a nearly unbounded waiting room beyond
     * the pool (queued jobs start as slots free); under any realistic backlog it
     * is queued rather than rejected. Overrides the instance-level
     * `opts.rejectWhenBusy`, whose default is `true` for `parallel: 1` and
     * `false` for `parallel >= 2`.
     */
    rejectWhenBusy?: boolean;
  }

  export interface BatchPrompt {
    /**
     * Correlates streamed chunks and results to this prompt. Auto-minted
     * (`batch-N`) when omitted; the `batch-` prefix is reserved for those
     * mints, so a provided id must not start with it.
     */
    id?: string;
    prompt: Message[];
    /**
     * Per-item options. `rejectWhenBusy` is a group policy — a batch is
     * admitted as one native job, so items that set it must agree (a conflict
     * throws `TypeError` before admission) and the agreed value gates the
     * whole group.
     */
    runOptions?: RunOptions;
  }

  export interface BatchOutputChunk {
    id: string;
    chunk: string;
  }

  export interface BatchResult {
    id: string;
    output: string;
  }

  export interface BatchResponse extends InferQvacResponse {
    ids: string[];
    /** Streamed chunks arrive on the `"output"` event. */
    on(event: "output", cb: (chunk: BatchOutputChunk) => void): this;
    on<E extends keyof BareEventMap, R>(
      name: E,
      fn: (...args: BareEventMap[E]) => R,
    ): this;
    onUpdate(cb: (chunk: BatchOutputChunk) => void): this;
    await(): Promise<BatchResult[]>;
  }

  export interface RuntimeStats {
    TTFT: number;
    TPS: number;
    ppTPS: number;
    /** Final cache tokens for single requests, or the sum across completed batch slots. */
    CacheTokens: number;
    generatedTokens: number;
    promptTokens: number;
    /** Context-window slides for single requests, or the sum across completed batch slots. */
    contextSlides: number;
    /**
     * Number of `<think>` (or model-equivalent) reasoning blocks dropped
     * from the KV cache at end-of-generation by the
     * `remove_thinking_from_context` feature. Per-inference for single
     * requests; summed across completed slots for batch requests. 0 when
     * the model has no recognised reasoning channel, when the feature
     * was disabled per-request, or when no reasoning blocks were emitted.
     */
    thinkingBlockDiscards: number;
    /**
     * How busy the shared backend was, not a property of your request: the
     * mean number of sequences decoded together per engine step, including
     * overlapping requests from other callers (capped by the `parallel`
     * configuration). 1.0 = the model was effectively yours alone; ~N = your
     * tokens shared compute with N-1 others, so this request's observed `TPS`
     * is roughly the backend's aggregate rate divided by N. Even on a single
     * request it tells apart "slow model" from "busy backend". Always
     * model-level — never per-job.
     */
    avgConcurrentSeq: number;
    backendDevice: "cpu" | "gpu";
    /**
     * Why generation stopped. Per-sequence, so it is reported for a single
     * request on either path (sequential or one prompt on a parallel model).
     *
     * Absent when it cannot be attributed to one request: a `runBatched` group
     * whose prompts stopped for different reasons reports nothing rather than
     * picking one, and the whole-model `runtimeStats()` view omits it while
     * continuous batching is active for the same reason.
     */
    stopReason?:
      | "none"
      | "eos"
      | "antiprompt"
      | "predictionLimit"
      | "sequenceLimit"
      | "contextOverflow";
    /** Vision-encode time for the most recent inference. Multimodal models only. */
    visionEncodeMs?: number;
    /** Vision slice/tile count for the most recent inference. Multimodal models only. */
    visionEncodeTiles?: number;
  }

  export interface FinetuneValidationNone {
    type: "none";
  }

  export interface FinetuneValidationSplit {
    type: "split";
    /** Fraction of training data to hold out for validation (0–1). Default 0.05. */
    fraction?: number;
  }

  export interface FinetuneValidationDataset {
    type: "dataset";
    /** Path to a separate eval dataset file. Must differ from trainDatasetDir. */
    path: string;
  }

  export type FinetuneValidation =
    | FinetuneValidationNone
    | FinetuneValidationSplit
    | FinetuneValidationDataset;

  export interface FinetuneOptions {
    /** Path to training dataset file (.jsonl for SFT, .txt for causal). */
    trainDatasetDir: string;
    /** How to run validation. */
    validation: FinetuneValidation;
    /** Directory (or file path ending in .gguf) for the final LoRA adapter. */
    outputParametersDir: string;
    /** Number of training epochs. Default 1. */
    numberOfEpochs?: number;
    /** Initial learning rate. Default 1e-4. */
    learningRate?: number;
    /** Training sequence length. Default 128. */
    contextLength?: number;
    /** Backend n_batch (tokens per batch). Must be >= microBatchSize and divisible by it. Default 128. */
    batchSize?: number;
    /** Backend n_ubatch (micro-batch size). Must be <= batchSize. Default 128. */
    microBatchSize?: number;
    /** Use SFT (chat) mode when true; causal (next-token) when false. Default false. */
    assistantLossOnly?: boolean;
    /** Comma-separated LoRA target modules (e.g. 'attn_q,attn_k,attn_v,attn_o'). Default: attention Q/K/V/O. */
    loraModules?: string;
    /** LoRA rank. Default 8. */
    loraRank?: number;
    /** LoRA alpha (scaling factor). Default 16.0. */
    loraAlpha?: number;
    /** LoRA init standard deviation. Default 0.02. */
    loraInitStd?: number;
    /** Seed for LoRA weight initialization (0 = non-deterministic). Default 42. */
    loraSeed?: number;
    /** Directory for checkpoints. Default './checkpoints'. */
    checkpointSaveDir?: string;
    /** Save a checkpoint every N optimizer steps (0 = only on pause). Default 0. */
    checkpointSaveSteps?: number;
    /** Path to a custom chat template file (for SFT). */
    chatTemplatePath?: string;
    /** Learning rate scheduler: 'constant', 'cosine', or 'linear'. Default 'cosine'. */
    lrScheduler?: "constant" | "cosine" | "linear";
    /** Minimum learning rate (for cosine/linear schedulers). Default 0. */
    lrMin?: number;
    /** Warmup ratio (0–1). Requires warmupRatioSet: true. Default 0.1. */
    warmupRatio?: number;
    /** When true, compute warmup steps from warmupRatio. */
    warmupRatioSet?: boolean;
    /** Explicit warmup steps (used when warmupStepsSet is true). Default 0. */
    warmupSteps?: number;
    /** When true, use warmupSteps directly instead of ratio. */
    warmupStepsSet?: boolean;
    /** Weight decay. Default 0.01. */
    weightDecay?: number;
  }

  export interface FinetuneProgressStats {
    is_train: boolean;
    loss: number;
    loss_uncertainty: number;
    accuracy: number;
    accuracy_uncertainty: number;
    global_steps: number;
    current_epoch: number;
    current_batch: number;
    total_batches: number;
    elapsed_ms: number;
    eta_ms: number;
  }

  export interface FinetuneHandle {
    on(event: "stats", cb: (stats: FinetuneProgressStats) => void): this;
    removeListener(event: "stats", cb: (stats: FinetuneProgressStats) => void): this;
    await(): Promise<FinetuneResult>;
  }

  export interface FinetuneStats {
    train_loss?: number;
    train_loss_uncertainty?: number;
    val_loss?: number;
    val_loss_uncertainty?: number;
    train_accuracy?: number;
    train_accuracy_uncertainty?: number;
    val_accuracy?: number;
    val_accuracy_uncertainty?: number;
    learning_rate?: number;
    global_steps: number;
    epochs_completed: number;
  }

  export interface FinetuneResult {
    op: "finetune";
    status: "COMPLETED" | "PAUSED";
    stats?: FinetuneStats;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors `QvacResponse<Output = any>` in @qvac/infer-base.
  export type QvacResponse<Output = any> = InferQvacResponseOf<Output>;
}

export = LlmLlamacpp;

// Runtime-redundant: ESM named imports need the top-level `module.exports.X =` form.
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- `module.exports` is untyped CommonJS surface. */
module.exports.pickPrimaryGgufPath = pickPrimaryGgufPath;
module.exports.QvacResponse = QvacResponse;
/* eslint-enable @typescript-eslint/no-unsafe-member-access */
