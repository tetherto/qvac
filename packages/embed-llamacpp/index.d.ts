import QvacLogger = require("@qvac/logging");
import { type QvacResponse } from "@qvac/infer-base";
import { type Addon, type GGMLConfig } from "./addon";
export type { GGMLConfig, NumericLike, AddonConfigurationParams, RuntimeStats, Addon } from "./addon";
export { BertInterface } from "./addon";
export type { QvacResponse };
export interface GGMLBertArgs {
    files: {
        model: string[];
    };
    config?: GGMLConfig;
    logger?: QvacLogger | Console | null;
    opts?: {
        stats?: boolean;
    };
}
/**
 * Returns the first shard (matching `-NNNNN-of-MMMMM.gguf`) or the sole
 * entry for single-file models. Matches the C++ shard-expansion contract
 * in `GGUFShards::expandGGUFIntoShards`.
 */
export declare function pickPrimaryGgufPath(files: string[]): string;
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
    private readonly _config;
    private readonly _job;
    private readonly _run;
    private _hasActiveResponse;
    constructor({ files, config, logger, opts }: GGMLBertArgs);
    load(): Promise<void>;
    private _load;
    private _streamShards;
    run(input: string | string[]): Promise<QvacResponse>;
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
