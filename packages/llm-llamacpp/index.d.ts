import QvacLogger = require("@qvac/logging");
import { QvacResponse } from "@qvac/infer-base";
import type * as AddonModule from "./addon";
type BareEventMap = Record<string | symbol, unknown[]>;
/** Aliases: inside the namespace, `QvacResponse` resolves to its own member. */
type InferQvacResponse = QvacResponse;
type InferQvacResponseOf<Output> = QvacResponse<Output>;
/** Aliases so the class expression's body can name the namespace types below. */
type BatchPrompt = LlmLlamacpp.BatchPrompt;
type BatchResponse = LlmLlamacpp.BatchResponse;
type FinetuneHandle = LlmLlamacpp.FinetuneHandle;
type FinetuneOptions = LlmLlamacpp.FinetuneOptions;
type LlmLlamacppArgs = LlmLlamacpp.LlmLlamacppArgs;
type Message = LlmLlamacpp.Message;
type RunOptions = LlmLlamacpp.RunOptions;
/**
 * Returns the first shard (matching `-NNNNN-of-MMMMM.gguf`) or the sole
 * entry for single-file models. Matches the C++ shard-expansion contract
 * in `GGUFShards::expandGGUFIntoShards`.
 */
declare function pickPrimaryGgufPath(files: string[]): string;
interface LlmLlamacpp {
    /** The native addon, or `null` before `load()` and after `unload()`. Advanced/test access only. */
    addon: LlmLlamacpp.Addon | null;
    opts: {
        stats?: boolean;
    };
    logger: QvacLogger;
    state: {
        configLoaded: boolean;
    };
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
    getState(): {
        configLoaded: boolean;
    };
}
interface LlmLlamacppConstructor {
    new (args: LlmLlamacppArgs): LlmLlamacpp;
    readonly prototype: LlmLlamacpp;
    /** Returns the first shard (matching `-NNNNN-of-MMMMM.gguf`) or the sole entry for single-file models. */
    readonly pickPrimaryGgufPath: typeof pickPrimaryGgufPath;
}
/** LLM client wrapping the native LlamaInterface for inference, finetuning, and pause/resume. */
declare const LlmLlamacpp: LlmLlamacppConstructor;
declare namespace LlmLlamacpp {
    type NumericLike = number | `${number}`;
    type AddonMessage = AddonModule.AddonMessage;
    type AddonMediaMessage = AddonModule.AddonMediaMessage;
    type AddonRunJobMessage = AddonModule.AddonRunJobMessage;
    /**
     * Discriminated admission result: the native binding only sets `id` when the
     * scheduler minted one, so a job id exists exactly when the job was accepted.
     */
    type AdmissionResult = AddonModule.AdmissionResult;
    type AddonRunJobResult = AddonModule.AddonRunJobResult;
    type AddonBatchRunItem = AddonModule.AddonBatchRunItem;
    /**
     * Batch admission result. The per-sequence `ids` are reported on both
     * branches (they are assigned while parsing the batch input); the native
     * group id used to route the batch's terminal events exists only when the
     * batch was accepted.
     */
    type AddonBatchRunResult = AddonModule.AddonBatchRunResult;
    interface Addon {
        loadWeights(data: {
            filename: string;
            chunk: Uint8Array | null;
            completed: boolean;
        }, logger?: QvacLogger): Promise<void>;
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
    interface LlamaConfig {
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
    interface LlmLlamacppArgs {
        files: {
            model: string[];
            projectionModel?: string;
        };
        config: LlamaConfig;
        logger?: QvacLogger | Console | null;
        /**
         * `rejectWhenBusy` is the instance-level admission policy when the worker
         * pool is full; defaults to `true` for `parallel: 1` and `false` for
         * `parallel >= 2`, and can be overridden per call via
         * `RunOptions.rejectWhenBusy` (see its doc for the full contract).
         */
        opts?: {
            stats?: boolean;
            rejectWhenBusy?: boolean;
        };
    }
    interface UserTextMessage {
        role: "system" | "assistant" | "user" | "tool" | "session" | string;
        content: string;
        type?: undefined;
        [key: string]: any;
    }
    interface UserMediaMessage {
        role: "user";
        type: "media";
        /**
         * Either the raw bytes of an image/audio/video file (`Uint8Array`) or an
         * absolute path to a file on disk (`string`). Path-mode is handled by the
         * C++ layer via `loadMedia()`; byte-mode takes the `parseMedia` path.
         */
        content: Uint8Array | string;
    }
    interface ChatFunctionDefinition {
        type: "function";
        name: string;
        description?: string;
        parameters?: Record<string, any>;
    }
    type Message = UserTextMessage | UserMediaMessage | ChatFunctionDefinition;
    interface GenerationParams {
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
    interface RunOptions {
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
    interface BatchPrompt {
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
    interface BatchOutputChunk {
        id: string;
        chunk: string;
    }
    interface BatchResult {
        id: string;
        output: string;
    }
    interface BatchResponse extends InferQvacResponse {
        ids: string[];
        /** Streamed chunks arrive on the `"output"` event. */
        on(event: "output", cb: (chunk: BatchOutputChunk) => void): this;
        on<E extends keyof BareEventMap, R>(name: E, fn: (...args: BareEventMap[E]) => R): this;
        onUpdate(cb: (chunk: BatchOutputChunk) => void): this;
        await(): Promise<BatchResult[]>;
    }
    interface RuntimeStats {
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
        stopReason?: "none" | "eos" | "antiprompt" | "predictionLimit" | "sequenceLimit" | "contextOverflow";
        /** Vision-encode time for the most recent inference. Multimodal models only. */
        visionEncodeMs?: number;
        /** Vision slice/tile count for the most recent inference. Multimodal models only. */
        visionEncodeTiles?: number;
    }
    interface FinetuneValidationNone {
        type: "none";
    }
    interface FinetuneValidationSplit {
        type: "split";
        /** Fraction of training data to hold out for validation (0–1). Default 0.05. */
        fraction?: number;
    }
    interface FinetuneValidationDataset {
        type: "dataset";
        /** Path to a separate eval dataset file. Must differ from trainDatasetDir. */
        path: string;
    }
    type FinetuneValidation = FinetuneValidationNone | FinetuneValidationSplit | FinetuneValidationDataset;
    interface FinetuneOptions {
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
    interface FinetuneProgressStats {
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
    interface FinetuneHandle {
        on(event: "stats", cb: (stats: FinetuneProgressStats) => void): this;
        removeListener(event: "stats", cb: (stats: FinetuneProgressStats) => void): this;
        await(): Promise<FinetuneResult>;
    }
    interface FinetuneStats {
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
    interface FinetuneResult {
        op: "finetune";
        status: "COMPLETED" | "PAUSED";
        stats?: FinetuneStats;
    }
    type QvacResponse<Output = any> = InferQvacResponseOf<Output>;
}
export = LlmLlamacpp;
