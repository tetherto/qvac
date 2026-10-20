import type { QvacResponse } from "@qvac/infer-base";
import type { AddonOutputCallback, NumericLike } from "./addon";
import { ModelInterface, ModelRunner, type MappedModelEvent, type ModelBinding, type ModelConfigurationParams, type ModelRunnerArgs } from "./modelRunner";
/**
 * Load options for {@link Reranker}. Any other key is rejected at load:
 * pooling, context size, ubatch and parallelism are fixed by the scoring
 * setup, and embedding options do not apply.
 */
export interface RerankConfig {
    /** Required: a missing device fails at load, as in GGMLBert. */
    device: "gpu" | "cpu";
    gpu_layers?: NumericLike;
    /**
     * Tokens per forward pass (default 2048). Each document, paired with the
     * query, must fit; documents are packed into as few passes as fit.
     */
    batch_size?: NumericLike;
    verbosity?: NumericLike;
    flash_attn?: "on" | "off" | "auto";
    /** Comma-separated GPU backend priority list, as in GGMLBert. */
    backend?: string;
    /** CPU threads, at most the device's CPU count. Unset uses one per physical core; `0` or below uses every logical CPU. */
    threads?: NumericLike;
    /** CPU threads for batch processing. Same limit as `threads`; unset uses `threads`. */
    "threads-batch"?: NumericLike;
    /** Main GGML threadpool busy-wait level, from 0 (sleep while idle) to 100 (maximum polling). Defaults to 0. */
    poll?: NumericLike;
    /** Batch GGML threadpool busy-wait level. Defaults to `poll`, or 0 when neither option is set. */
    "poll-batch"?: NumericLike;
    "main-gpu"?: NumericLike | "integrated" | "dedicated";
    "split-mode"?: "none" | "layer";
    "tensor-split"?: string;
    /** Writable directory for OpenCL kernel binary cache. Required on Android for fast GPU startup. */
    openclCacheDir?: string;
}
export interface RerankRequest {
    query: string;
    documents: string[];
}
/**
 * One relevance score per document, in the order the documents were given.
 * Higher is more relevant. It is the model's raw classifier output (a logit for
 * most rerankers), so compare scores within one model, not across models.
 */
export type RerankScores = number[];
export type RerankerArgs = ModelRunnerArgs<RerankConfig>;
export interface RerankBinding extends ModelBinding {
    createRerankInstance(owner: RerankInterface, configurationParams: {
        path: string;
        config: RerankConfig;
        backendsDir?: string;
    }, outputCallback: AddonOutputCallback): object;
    runJob(handle: unknown, input: {
        type: "sequences";
        input: string[];
    }): Promise<boolean>;
}
export type MappedRerankEvent = MappedModelEvent<RerankScores>;
/**
 * Normalize a raw native event of a rerank instance. The scores arrive as a
 * Float32Array and are returned as numbers; `backendDevice` in the stats maps
 * `0/1` to `'cpu'/'gpu'`. Returns `null` for unknown events.
 */
export declare function mapRerankEvent(rawEvent: unknown, rawData: unknown, rawError: unknown): MappedRerankEvent | null;
/** An interface between the native rerank instance and the JS runtime. */
export declare class RerankInterface extends ModelInterface<RerankConfig, RerankBinding> {
    protected _createInstance(configurationParams: ModelConfigurationParams<RerankConfig>, outputCb: AddonOutputCallback): object;
    /** Resolves `true` if the job was accepted, `false` if busy. */
    runJob(query: string, documents: string[]): Promise<boolean>;
}
/**
 * Scores documents by relevance to a query with a reranker (cross-encoder)
 * GGUF, such as bge-reranker, jina-reranker or Qwen3-Reranker.
 *
 * ```js
 * const reranker = new Reranker({ files: { model: [path] }, config: { device: 'gpu', gpu_layers: '99' } })
 * await reranker.load()
 * const [scores] = await (await reranker.run({ query, documents })).await()
 * ```
 */
export declare class Reranker extends ModelRunner<RerankConfig, RerankRequest, RerankRequest, RerankScores, RerankInterface> {
    protected readonly _modelName = "Rerank";
    /**
     * Scores each document against the query. `await()` on the response
     * resolves to `[scores]`, one score per document in the given order.
     */
    run(request: RerankRequest): Promise<QvacResponse<RerankScores>>;
    protected _createAddon(binding: unknown, configurationParams: ModelConfigurationParams<RerankConfig>, outputCb: AddonOutputCallback): RerankInterface;
    protected _encodeRequest(request: RerankRequest): RerankRequest;
    protected _startJob(addon: RerankInterface, request: RerankRequest): Promise<boolean>;
    protected _mapEvent(event: unknown, data: unknown, error: unknown): MappedRerankEvent | null;
}
