import QvacLogger = require("@qvac/logging");
import { type QvacResponse } from "@qvac/infer-base";
import { type Addon, type EmbedRunInput, type GGMLConfig } from "./addon";
export type { GGMLConfig, NumericLike, AddonConfigurationParams, RuntimeStats, Addon, EmbedMediaPart, EmbedInputPart, EmbedMultimodalInput, EmbedBatchInput, EmbedRunInput, } from "./addon";
export { BertInterface, pickPrimaryGgufPath } from "./addon";
export { LayaDecisions, LayaInterface, mapLayaEvent } from "./laya";
export type { LayaConfig, LayaRequest, LayaSingleRequest, LayaBatchRequest, LayaQuestion, LayaChoiceQuestion, LayaScoreQuestion, LayaNoulQuestion, LayaState, LayaCriterion, LayaResponse, LayaResult, LayaAnswer, LayaChoiceAnswer, LayaScoreAnswer, LayaNoulAnswer, LayaUsage, LayaDecisionsArgs, } from "./laya";
export { Reranker, RerankInterface, mapRerankEvent } from "./rerank";
export type { RerankConfig, RerankRequest, RerankScores, RerankerArgs, } from "./rerank";
export { assessFit } from "./fit";
export type { EmbedFitDevice, EmbedFitRequest, EmbedFitResult, EmbedFitStatus } from "./fit";
export type { QvacResponse };
export interface GGMLBertArgs {
    /**
     * `model`: the GGUF file, or all shards of a sharded GGUF.
     * `projectionModel`: optional projection model (mmproj) that lets `run()`
     * embed images and audio, for multimodal embedding models such as
     * EmbeddingGemma 2.
     */
    files: {
        model: string[];
        projectionModel?: string;
    };
    config?: GGMLConfig;
    logger?: QvacLogger | Console | null;
    opts?: {
        stats?: boolean;
    };
}
/** BERT client wrapping the native BertInterface for embedding generation. */
export declare class GGMLBert {
    protected addon: Addon | null;
    logger: QvacLogger;
    opts: {
        stats?: boolean;
    };
    state: {
        configLoaded: boolean;
    };
    private readonly _files;
    private readonly _projectionModelPath;
    private readonly _config;
    private readonly _job;
    private readonly _run;
    private _hasActiveResponse;
    constructor({ files, config, logger, opts }: GGMLBertArgs);
    load(): Promise<void>;
    private _load;
    private _streamShards;
    /**
     * Embed text, or text mixed with images and audio when the model was given
     * `files.projectionModel`. See {@link EmbedRunInput} for the input shapes.
     */
    run(input: EmbedRunInput): Promise<QvacResponse>;
    private _runInternal;
    private _addonOutputCallback;
    private _createAddon;
    /**
     * Unload the model and clear resources. Ensures any in-flight job is resolved as failed.
     */
    unload(): Promise<void>;
    /** Cancel the current task. */
    cancel(): Promise<void>;
    getState(): {
        configLoaded: boolean;
    };
}
export default GGMLBert;
